#!/usr/bin/env node
// Reports what a Claude Code session used to Aidelix (AIT-1071).
//
// Run by the plugin's Stop hook. It reads the session's own transcript and
// its subagents' logs on this machine, finds each Aidelix work session the
// agent opened with claim_ticket, and gives every assistant turn after a
// claim to the work session claimed last before it. For each work session it
// sends only numbers to `POST /v1/sessions/:id/usage`: per model, the input,
// output, cache-read and cache-write token counts. Never a prompt, a reply,
// code, a path or the transcript. Aidelix prices them for estimates and
// never bills them.
//
// The report id is a hash of the Claude Code session, the work session and
// the claim time, so each stop sends the same id with totals that only grow,
// and Aidelix keeps one row for it: a turn is never counted twice.
//
// It fails open and stays quiet: no key, an unreadable transcript, a refused
// or failed request, all end the hook with nothing said. Each request times
// out after a few seconds. AIDELIX_REPORT_USAGE=0 turns it off.
//
// No dependencies: it runs on Node 18 or later.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from './bridge.mjs';

const TIMEOUT_MS = 5_000;
/** The most models one report may name, as the API takes. */
const MAX_MODELS = 16;
/** The most work sessions one stop reports on. */
const MAX_SESSIONS = 10;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parse(line) {
  try {
    const entry = JSON.parse(line);
    return typeof entry === 'object' && entry !== null ? entry : null;
  } catch {
    return null;
  }
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/** The text of a tool result block, whether a string or text parts. */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

/**
 * The work sessions the agent opened in this transcript, oldest first:
 * `{ sessionId, at }`, where `at` is when the claim_ticket answer came
 * back. A session claimed again keeps its first claim.
 */
export function claims(transcript) {
  const pending = new Set();
  const found = [];
  for (const line of transcript.split('\n')) {
    if (!line.includes('claim_ticket') && pending.size === 0) continue;
    const entry = parse(line);
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block?.type === 'tool_use' &&
        /(^|__)claim_ticket$/.test(String(block.name)) &&
        typeof block.id === 'string'
      ) {
        pending.add(block.id);
        continue;
      }
      if (block?.type !== 'tool_result' || !pending.has(block.tool_use_id)) {
        continue;
      }
      pending.delete(block.tool_use_id);
      if (block.is_error) continue;
      const session = parse(resultText(block.content));
      const at = Date.parse(String(entry.timestamp));
      const id = session?.id;
      if (typeof id !== 'string' || !UUID.test(id) || Number.isNaN(at)) {
        continue;
      }
      const sessionId = id.toLowerCase();
      if (found.some((one) => one.sessionId === sessionId)) continue;
      found.push({ sessionId, at });
    }
  }
  return found;
}

/** One assistant turn of a log line, or null. */
function turnOf(line) {
  if (!line.includes('"assistant"')) return null;
  const entry = parse(line);
  if (entry?.type !== 'assistant') return null;
  const message = entry.message;
  const model = message?.model;
  const usage = message?.usage;
  // `<synthetic>` marks a reply Claude Code wrote itself, with no model call.
  if (typeof model !== 'string' || !model || model.startsWith('<')) {
    return null;
  }
  if (typeof usage !== 'object' || usage === null) return null;
  const at = Date.parse(String(entry.timestamp));
  if (Number.isNaN(at)) return null;
  const cacheWrite = count(usage.cache_creation_input_tokens);
  const oneHour = Math.min(
    count(usage.cache_creation?.ephemeral_1h_input_tokens),
    cacheWrite,
  );
  const id =
    typeof message.id === 'string'
      ? message.id
      : typeof entry.requestId === 'string'
        ? entry.requestId
        : null;
  return {
    id,
    model,
    at,
    tokens: {
      inputTokens: count(usage.input_tokens),
      outputTokens: count(usage.output_tokens),
      cacheReadTokens: count(usage.cache_read_input_tokens),
      cacheWriteTokens: cacheWrite,
      cacheWrite1hTokens: oneHour,
    },
  };
}

/**
 * Each work session's token totals by model, from the logs: a turn belongs
 * to the session claimed last before it, and a reply Claude Code wrote over
 * several lines counts once, by its message id. Turns before the first
 * claim belong to no ticket and are left out.
 */
export function usageBySession(logs, sessionClaims) {
  const ordered = [...sessionClaims].sort((a, b) => a.at - b.at);
  const owner = (at) => {
    let found = null;
    for (const claim of ordered) {
      if (claim.at <= at) found = claim;
      else break;
    }
    return found;
  };
  const byId = new Map();
  const anonymous = [];
  for (const log of logs) {
    for (const line of log.split('\n')) {
      const turn = turnOf(line);
      if (!turn) continue;
      if (turn.id === null) {
        anonymous.push(turn);
        continue;
      }
      const seen = byId.get(turn.id);
      if (!seen || turn.tokens.outputTokens >= seen.tokens.outputTokens) {
        byId.set(turn.id, turn);
      }
    }
  }
  const reports = new Map();
  for (const turn of [...byId.values(), ...anonymous]) {
    const claim = owner(turn.at);
    if (!claim) continue;
    let report = reports.get(claim.sessionId);
    if (!report) {
      report = { ...claim, models: {}, lastTurnAt: claim.at };
      reports.set(claim.sessionId, report);
    }
    const sum = (report.models[turn.model] ??= {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    sum.inputTokens += turn.tokens.inputTokens;
    sum.outputTokens += turn.tokens.outputTokens;
    sum.cacheReadTokens += turn.tokens.cacheReadTokens;
    sum.cacheWriteTokens += turn.tokens.cacheWriteTokens;
    if (turn.tokens.cacheWrite1hTokens > 0) {
      sum.cacheWrite1hTokens =
        (sum.cacheWrite1hTokens ?? 0) + turn.tokens.cacheWrite1hTokens;
    }
    report.lastTurnAt = Math.max(report.lastTurnAt, turn.at);
  }
  return [...reports.values()];
}

/** The same id for the same Claude Code session, work session and claim. */
export function reportId(claudeSession, sessionId, at) {
  const digest = createHash('sha256')
    .update(`${claudeSession}\n${sessionId}\n${at}`)
    .digest('hex');
  return `claude:${digest.slice(0, 40)}`;
}

/** The transcript and its subagents' logs, which may be missing. */
export function readLogs(transcriptPath, read = readFileSync) {
  const logs = [read(transcriptPath, 'utf8')];
  const folder = join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
  let names = [];
  try {
    names = readdirSync(folder).filter((name) => name.endsWith('.jsonl'));
  } catch {
    names = [];
  }
  for (const name of names.sort()) {
    try {
      logs.push(read(join(folder, name), 'utf8'));
    } catch {
      // A log that vanished mid-read counts as empty.
    }
  }
  return logs;
}

/**
 * Sends each work session's report. Returns how many were sent; never
 * throws for a request that fails.
 */
export async function reportUsage({ input, env, fetch, readLogs: read }) {
  if (env.AIDELIX_REPORT_USAGE?.trim() === '0') return 0;
  const { endpoint, key } = config(env);
  if (!key || !input?.transcript_path) return 0;
  const base = endpoint.replace(/\/v1\/mcp$/, '');
  let logs;
  try {
    logs = read(input.transcript_path);
  } catch {
    return 0;
  }
  const claimed = claims(logs[0]).slice(-MAX_SESSIONS);
  if (claimed.length === 0) return 0;
  const claudeSession = basename(String(input.transcript_path), '.jsonl');
  let sent = 0;
  for (const report of usageBySession(logs, claimed)) {
    const names = Object.keys(report.models);
    if (names.length === 0 || names.length > MAX_MODELS) continue;
    try {
      const res = await fetch(`${base}/v1/sessions/${report.sessionId}/usage`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          reportId: reportId(claudeSession, report.sessionId, report.at),
          source: 'claude_hook',
          models: report.models,
          durationMs: Math.min(
            2_147_483_647,
            Math.max(0, report.lastTurnAt - report.at),
          ),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) sent += 1;
    } catch {
      // Fail open: the next stop sends the same totals again.
    }
  }
  return sent;
}

// Run as a program: the Stop event's JSON on stdin. It writes nothing.
const main = process.argv[1] && pathToFileURL(realpathSync(process.argv[1]));
if (main && import.meta.url === main.href) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (raw += chunk));
  process.stdin.on('end', async () => {
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      return;
    }
    await reportUsage({
      input,
      env: process.env,
      fetch: globalThis.fetch,
      readLogs: (path) => readLogs(path),
    });
  });
}
