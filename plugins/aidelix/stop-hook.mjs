#!/usr/bin/env node
// The plugin's Claude Code Stop hook (AIT-575).
//
// When the agent tries to end its turn, the hook asks Aidelix whether a
// ticket the agent claimed in this session still waits on it, and if so
// keeps the session going with the list as the reason. Each job the hook
// does is one check in `CHECKS`: a check takes the context and returns the
// lines that should keep the session going, or none.
//
// Run with --watch (AIT-551), the same hook waits in the background after
// the session stops: while a ticket the session claimed is in review, it
// long-polls Aidelix for an act that needs the agent (a Request changes, a
// finding or thread sent, a rejection, a question asked or answered, CI
// failing, a merge) or an approval, and then wakes the session with the
// event and the same CHECKS. Claude Code starts it with `asyncRewake`,
// which wakes the session when it exits 2. It waits
// AIDELIX_STOP_HOOK_WATCH_HOURS (8 by default; 0 turns the watch off), and
// a newer stop of the same session takes over from it.
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
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from './bridge.mjs';

const TIMEOUT_MS = 10_000;
/** The longest the API holds a request for events (AIT-169). */
const EVENT_WAIT_SECONDS = 25;
/** How long the watch waits after a stop, unless the environment says. */
const WATCH_HOURS = 8;
/** How long the watch rests after a failed request. */
const RETRY_MS = 30_000;
/** How far back a session's first watch looks, for what came before it. */
const LOOKBACK_MS = 60 * 60_000;
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
async function getJson({ base, key, fetch }, path, timeoutMs = TIMEOUT_MS) {
  const res = await fetch(`${base}/v1${path}`, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`${path} answered ${res.status}`), {
      status: res.status,
    });
  }
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
  // Side by side, inside the hook's time, and one ticket that cannot be
  // read (deleted, moved) does not hide the others.
  const answers = await Promise.allSettled(
    context.tickets.map(async (ref) => {
      const ticket = await getJson(
        context,
        UUID.test(ref)
          ? `/tickets/${ref}`
          : `/tickets/by-key/${encodeURIComponent(ref)}`,
      );
      if (ticket.status === 'done') return null;
      const { needsYou } = await getJson(
        context,
        `/tickets/${ticket.id}/needs-you`,
      );
      return needsYou ? { key: ticket.key, needsYou } : null;
    }),
  );
  const waiting = answers.flatMap((answer) =>
    answer.status === 'fulfilled' && answer.value ? [answer.value] : [],
  );
  if (waiting.length === 0) return [];
  return [
    ...waiting.flatMap(({ key, needsYou }) => needsYouLines(key, needsYou)),
    waiting[0].needsYou.remedy,
  ];
}

/** Every job the Stop hook does, in order. */
export const CHECKS = [needsYouCheck];

/** The API base and key, or null when the hook is off or has no key. */
function connection(env) {
  if (env.AIDELIX_STOP_HOOK === '0') return null;
  const { endpoint, key } = config(env);
  if (!key) return null;
  return { base: endpoint.replace(/\/v1\/mcp$/, ''), key };
}

/**
 * The events the watch wakes the session for, as `ait watch --until
 * approved,needs-me` reads them.
 */
export function wakesAgent(event) {
  return (
    event.kind === 'approved' ||
    event.kind === 'review_requested_changes' ||
    event.kind === 'review_thread_waiting' ||
    event.kind === 'rejected' ||
    event.kind === 'question_asked' ||
    event.kind === 'question_answered' ||
    event.kind === 'pr_merged' ||
    (event.kind === 'ci_finished' && event.detail?.result === 'failing')
  );
}

/** One line for an event: names and ids, never text a person wrote. */
function eventLine(event) {
  return [
    event.ticket,
    event.kind,
    ...Object.entries(event.detail ?? {}).map(
      ([name, value]) => `${name}=${String(value)}`,
    ),
    ...(event.subjectId ? [event.subjectId] : []),
  ].join('  ');
}

/**
 * The watch after a stop (AIT-551): the message that wakes the session, or
 * null to let it rest. It keys on the claimed tickets that are in review,
 * waits on them through `GET /v1/events` until an event in `wakesAgent`
 * arrives, then adds what CHECKS say. `current()` is false once a newer
 * stop of the session took over the watch. `cursor` keeps the session's
 * place in the events across watches, so a handover or a wake loses
 * nothing; a session's first watch starts an hour back, since an approval
 * or red CI can come between the move to in_review and the stop.
 */
export async function watchDecision({
  input,
  env,
  fetch,
  readTranscript,
  current,
  cursor,
  sleep,
  now = Date.now,
  checks = CHECKS,
}) {
  const conn = connection(env);
  if (!conn || !input?.transcript_path) return null;
  const hours = Number(env.AIDELIX_STOP_HOOK_WATCH_HOURS ?? WATCH_HOURS);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  const deadline = now() + hours * 3_600_000;
  let claimed;
  try {
    claimed = claimedTickets(readTranscript(input.transcript_path));
  } catch {
    return null;
  }
  const context = { ...conn, fetch, tickets: claimed };
  // Only a ticket the agent handed off waits for a person's act.
  const reads = await Promise.allSettled(
    claimed.map((ref) =>
      getJson(
        context,
        UUID.test(ref)
          ? `/tickets/${ref}`
          : `/tickets/by-key/${encodeURIComponent(ref)}`,
      ),
    ),
  );
  let tickets = reads.flatMap((read) =>
    read.status === 'fulfilled' && read.value?.status === 'in_review'
      ? [read.value.key]
      : [],
  );
  if (tickets.length === 0) return null;
  let after = cursor.read() || undefined;
  const since = new Date(now() - LOOKBACK_MS).toISOString();
  while (current() && now() < deadline) {
    const params = new URLSearchParams({
      tickets: tickets.join(','),
      wait: String(EVENT_WAIT_SECONDS),
    });
    if (after !== undefined) params.set('after', after);
    else params.set('since', since);
    let page;
    const asked = now();
    try {
      page = await getJson(
        context,
        `/events?${params.toString()}`,
        (EVENT_WAIT_SECONDS + 15) * 1000,
      );
    } catch (err) {
      // A saved place the API no longer reads: start again from since.
      if (err.status === 400 && after !== undefined) {
        after = undefined;
        cursor.write('');
        continue;
      }
      // A refusal (a revoked key, a ticket gone) will not get better.
      if (err.status >= 400 && err.status < 500 && err.status !== 429) {
        return null;
      }
      await sleep(RETRY_MS);
      continue;
    }
    // A newer stop may have taken over while the request waited: it goes
    // on from the saved place, so these events are its own.
    if (!current()) return null;
    after = page.next;
    cursor.write(after);
    const events = page.events.filter(wakesAgent);
    if (events.length === 0) {
      // A ticket a person moved out of review no longer waits on them.
      // The move may be an old one read again, so ask where it is now.
      const moved = new Set(
        page.events
          .filter(
            (event) =>
              event.kind === 'status_changed' &&
              event.detail?.to !== 'in_review',
          )
          .map((event) => event.ticket),
      );
      for (const key of moved) {
        try {
          const ticket = await getJson(
            context,
            `/tickets/by-key/${encodeURIComponent(key)}`,
          );
          if (ticket.status === 'in_review') continue;
        } catch {
          continue;
        }
        tickets = tickets.filter((one) => one !== key);
      }
      if (tickets.length === 0) return null;
      // An empty answer long before its wait (a server shutting down)
      // must not become a tight loop.
      if (now() - asked < (EVENT_WAIT_SECONDS * 1000) / 2) await sleep(1000);
      continue;
    }
    const lines = [];
    for (const check of checks) {
      try {
        lines.push(...(await check({ ...context, tickets })));
      } catch {
        // The event alone is enough to wake the session.
      }
    }
    return [
      'Aidelix: a person acted on a ticket you handed off. Call get_ticket ' +
        'for it and do what it needs: merge an approved review if your ' +
        'instructions say so, move a merged one to done, or answer what ' +
        'waits on you.',
      ...events.map(eventLine),
      ...lines,
    ].join('\n');
  }
  return null;
}

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
  const conn = connection(env);
  if (!conn || !input?.transcript_path) return null;
  let tickets;
  try {
    tickets = claimedTickets(readTranscript(input.transcript_path));
  } catch {
    return null;
  }
  if (tickets.length === 0) return null;
  const context = { ...conn, fetch, tickets };
  const lines = [];
  for (const check of checks) {
    try {
      lines.push(...(await check(context)));
    } catch {
      // Fail open: a check that cannot tell lets the session stop.
    }
  }
  if (lines.length === 0) {
    // Nothing waits: a list that comes back later blocks once again.
    if (seen.read()) seen.write('');
    return null;
  }
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

/** Where the hook keeps `what` for a session: its last list, its watch. */
function sessionFile(what, sessionId) {
  const safe = String(sessionId ?? 'session').replace(/[^A-Za-z0-9_-]/g, '');
  return join(tmpdir(), `aidelix-${what}-${safe || 'session'}.txt`);
}

/** Reads a file, or null. */
function readOrNull(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Writes a file only its owner reads; a failure is no harm. */
function writeQuietly(file, text) {
  try {
    writeFileSync(file, text, { mode: 0o600 });
  } catch {
    // Without the file the hook does a little more work, never less.
  }
}

// Run as a program: the Stop event's JSON on stdin. The Stop hook writes
// its decision on stdout; with --watch it writes the wake-up on stderr and
// exits 2, which `asyncRewake` hands the session.
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
    const readTranscript = (path) => readFileSync(path, 'utf8');
    if (process.argv.includes('--watch')) {
      const file = sessionFile('watch', input.session_id);
      const place = sessionFile('cursor', input.session_id);
      const token = randomUUID();
      writeQuietly(file, token);
      const wake = await watchDecision({
        input,
        env: process.env,
        fetch: globalThis.fetch,
        readTranscript,
        // Without the file, the watch runs to its deadline.
        current: () => (readOrNull(file) ?? token) === token,
        cursor: {
          read: () => readOrNull(place),
          write: (text) => writeQuietly(place, text),
        },
        sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      });
      if (wake) {
        process.stderr.write(`${wake}\n`);
        process.exit(2);
      }
      return;
    }
    const file = sessionFile('stop', input.session_id);
    const decision = await stopDecision({
      input,
      env: process.env,
      fetch: globalThis.fetch,
      readTranscript,
      seen: {
        read: () => readOrNull(file),
        write: (text) => writeQuietly(file, text),
      },
    });
    if (decision) process.stdout.write(`${JSON.stringify(decision)}\n`);
  });
}
