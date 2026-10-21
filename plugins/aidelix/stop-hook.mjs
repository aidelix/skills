#!/usr/bin/env node
// The plugin's Claude Code Stop hook (AIT-575).
//
// When the agent tries to end its turn, the hook asks Aidelix whether a
// ticket the agent claimed in this session still waits on it, and if so
// keeps the session going with the list as the reason. Each job the hook
// does is one check in `CHECKS`: a check takes the context and returns the
// lines that should keep the session going, or none. AIT-551 adds its
// check here rather than a second hook.
//
// It fails open: a missing key, a refused or failed request, or a
// transcript it cannot read lets the session stop, so a hook problem never
// traps anyone. It blocks a stop only once for the same list: an item only
// a person can settle (a standing Request changes, a thread they have not
// resolved) does not hold the session forever. AIDELIX_STOP_HOOK=0 turns
// it off.
//
// No dependencies: it runs on Node 18 or later.

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setting } from './bridge.mjs';

const DEFAULT_URL = 'https://api.aidelix.com';
const TIMEOUT_MS = 10_000;
/** The most tickets one stop asks about. */
const MAX_TICKETS = 10;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/**
 * The tickets the agent claimed in this session, newest last, read from
 * the transcript Claude Code keeps: each claim_ticket call through the
 * Aidelix MCP server, by whatever name the server is mounted under.
 */
export function claimedTickets(transcript) {
  const tickets = [];
  for (const line of transcript.split('\n')) {
    if (!line.includes('claim_ticket')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_use') continue;
      if (!/(^|__)claim_ticket$/.test(String(block.name))) continue;
      const ticket = String(block.input?.ticket ?? '').trim();
      if (!UUID.test(ticket) && !KEY.test(ticket)) continue;
      const ref = UUID.test(ticket)
        ? ticket.toLowerCase()
        : ticket.toUpperCase();
      const at = tickets.indexOf(ref);
      if (at !== -1) tickets.splice(at, 1);
      tickets.push(ref);
    }
  }
  return tickets.slice(-MAX_TICKETS);
}

/** GET a path of the API as JSON, or throw. */
async function getJson({ base, key, fetch }, path) {
  const res = await fetch(`${base}/v1${path}`, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}

/** The lines `ait needs-you` prints for one ticket, ids and counts only. */
export function needsYouLines(key, needsYou) {
  return [
    `${key} waits on you:`,
    ...needsYou.reviews.flatMap((review) => [
      `  Review ${review.reviewId}${review.prNumber == null ? '' : ` (PR #${review.prNumber})`}:`,
      ...review.findings.map(
        (finding) => `    finding ${finding.id} (${finding.severity})`,
      ),
      ...review.threads.map((thread) => `    thread ${thread} waiting on you`),
      ...(review.changesRequested.length === 0
        ? []
        : [`    ${review.changesRequested.length} Request changes standing`]),
    ]),
  ];
}

/**
 * The needsYou check: what the open reviews of each claimed ticket wait on
 * the agent for, through `GET /v1/tickets/:id/needs-you`, the route
 * `ait needs-you` reads.
 */
export async function needsYouCheck(context) {
  const lines = [];
  let remedy;
  for (const ref of context.tickets) {
    const ticket = await getJson(
      context,
      UUID.test(ref)
        ? `/tickets/${ref}`
        : `/tickets/by-key/${encodeURIComponent(ref)}`,
    );
    if (ticket.status === 'done') continue;
    const { needsYou } = await getJson(
      context,
      `/tickets/${ticket.id}/needs-you`,
    );
    if (!needsYou) continue;
    lines.push(...needsYouLines(ticket.key, needsYou));
    remedy = needsYou.remedy;
  }
  return lines.length === 0 ? [] : [...lines, remedy];
}

/** Every job the Stop hook does, in order. AIT-551 adds its own here. */
export const CHECKS = [needsYouCheck];

/**
 * What the hook answers for one Stop: `{ decision: 'block', reason }` to
 * keep the session going, or null to let it stop. `seen` reads and writes
 * the list it last blocked on for this session.
 */
export async function stopDecision({
  input,
  env,
  fetch,
  readTranscript,
  seen,
  checks = CHECKS,
}) {
  if (env.AIDELIX_STOP_HOOK === '0') return null;
  const key = setting(env, 'API_KEY')?.value;
  if (!key || !input?.transcript_path) return null;
  const base = (setting(env, 'URL')?.value ?? DEFAULT_URL)
    .replace(/\/+$/, '')
    .replace(/\/v1$/, '');
  let tickets;
  try {
    tickets = claimedTickets(readTranscript(input.transcript_path));
  } catch {
    return null;
  }
  if (tickets.length === 0) return null;
  const context = { base, key, fetch, tickets };
  const lines = [];
  for (const check of checks) {
    try {
      lines.push(...(await check(context)));
    } catch {
      // Fail open: a check that cannot tell lets the session stop.
    }
  }
  if (lines.length === 0) return null;
  const reason = lines.join('\n');
  // Once for the same list: what is left is a person's to settle.
  if (seen.read() === reason) return null;
  seen.write(reason);
  return {
    decision: 'block',
    reason:
      'Aidelix: before you stop, answer what waits on you on the tickets ' +
      `you claimed.\n${reason}`,
  };
}

/** Where the list a session last blocked on is kept. */
function seenFile(sessionId) {
  const safe = String(sessionId ?? 'session').replace(/[^A-Za-z0-9_-]/g, '');
  return join(tmpdir(), `aidelix-stop-${safe || 'session'}.txt`);
}

// Run as a program: the Stop event's JSON on stdin, the decision on stdout.
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
    const file = seenFile(input.session_id);
    const decision = await stopDecision({
      input,
      env: process.env,
      fetch: globalThis.fetch,
      readTranscript: (path) => readFileSync(path, 'utf8'),
      seen: {
        read: () => {
          try {
            return readFileSync(file, 'utf8');
          } catch {
            return null;
          }
        },
        write: (text) => {
          try {
            writeFileSync(file, text, { mode: 0o600 });
          } catch {
            // Without the file the next stop may block once more; no harm.
          }
        },
      },
    });
    if (decision) process.stdout.write(`${JSON.stringify(decision)}\n`);
  });
}
