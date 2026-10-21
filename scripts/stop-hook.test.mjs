import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHECKS,
  claimedTickets,
  stopDecision,
} from '../plugins/aidelix/stop-hook.mjs';

// The plugin's Stop hook (AIT-575): a session that claimed a ticket does
// not stop while the ticket's open reviews wait on the agent.
const TICKET_ID = '33333333-3333-4333-8333-333333333333';
const REVIEW_ID = '44444444-4444-4444-8444-444444444444';
const KEY = 'ait_0123456789abcdef_secretsecretsecretsecretsecretsecretsecr';
const ENV = { AIDELIX_URL: 'http://api.test/', AIDELIX_API_KEY: KEY };

const toolUse = (name, input) =>
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'x', name, input }] },
  });

const TRANSCRIPT = [
  JSON.stringify({ type: 'user', message: { content: 'Work AIT-575.' } }),
  toolUse('mcp__plugin_aidelix_aidelix__get_ticket', { ticket: 'AIT-1' }),
  toolUse('mcp__plugin_aidelix_aidelix__claim_ticket', { ticket: 'ait-575' }),
  'not json',
].join('\n');

const WAITING = {
  ticketId: TICKET_ID,
  needsYou: {
    reviews: [
      {
        reviewId: REVIEW_ID,
        prNumber: 12,
        findings: [{ id: 'f-1', severity: 'major' }],
        threads: ['t-1'],
        changesRequested: [],
      },
    ],
    remedy: 'Answer each.',
  },
};

/** A fake API, and what it was asked. */
function api(needsYou = WAITING, status = 'in_progress') {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization });
    if (url === 'http://api.test/v1/tickets/by-key/AIT-575')
      return Response.json({ id: TICKET_ID, key: 'AIT-575', status });
    if (url === `http://api.test/v1/tickets/${TICKET_ID}/needs-you`)
      return Response.json(needsYou);
    return new Response('{}', { status: 404 });
  };
  return { calls, fetch };
}

function memory() {
  let text = null;
  return { read: () => text, write: (value) => (text = value) };
}

const decide = (over = {}) =>
  stopDecision({
    input: { session_id: 's', transcript_path: '/t.jsonl' },
    env: ENV,
    fetch: api().fetch,
    readTranscript: () => TRANSCRIPT,
    seen: memory(),
    ...over,
  });

describe('Stop hook', () => {
  it('reads the tickets claimed in the session from its transcript', () => {
    expect(claimedTickets(TRANSCRIPT)).toEqual(['AIT-575']);
    expect(
      claimedTickets(
        [
          toolUse('mcp__aidelix__claim_ticket', { ticket: TICKET_ID }),
          toolUse('mcp__aidelix__claim_ticket', { ticket: 'AIT-2' }),
          toolUse('mcp__aidelix__claim_ticket', { ticket: TICKET_ID }),
          toolUse('mcp__other__claim_ticket_now', { ticket: 'AIT-3' }),
          toolUse('mcp__aidelix__claim_ticket', { ticket: '../../etc' }),
        ].join('\n'),
      ),
    ).toEqual(['AIT-2', TICKET_ID]);
  });

  it('blocks the stop with the list while something waits, once for the same list', async () => {
    const { calls, fetch } = api();
    const seen = memory();
    const first = await decide({ fetch, seen });
    expect(first.decision).toBe('block');
    expect(first.reason).toContain('AIT-575 waits on you:');
    expect(first.reason).toContain(`Review ${REVIEW_ID} (PR #12):`);
    expect(first.reason).toContain('finding f-1 (major)');
    expect(first.reason).toContain('thread t-1 waiting on you');
    expect(first.reason).toContain('Answer each.');
    expect(calls.every((call) => call.auth === `Bearer ${KEY}`)).toBe(true);
    // The same list again is a person's to settle: the session may stop.
    expect(await decide({ fetch, seen })).toBeNull();
  });

  it('lets the session stop when nothing waits, the ticket is done, or the hook is off', async () => {
    expect(
      await decide({
        fetch: api({ ticketId: TICKET_ID, needsYou: null }).fetch,
      }),
    ).toBeNull();
    expect(await decide({ fetch: api(WAITING, 'done').fetch })).toBeNull();
    expect(
      await decide({ env: { ...ENV, AIDELIX_STOP_HOOK: '0' } }),
    ).toBeNull();
    expect(await decide({ readTranscript: () => '' })).toBeNull();
  });

  it('fails open: no key, an unreadable transcript or a failed request lets it stop', async () => {
    expect(
      await decide({ env: { AIDELIX_URL: 'http://api.test' } }),
    ).toBeNull();
    expect(
      await decide({
        readTranscript: () => {
          throw new Error('gone');
        },
      }),
    ).toBeNull();
    expect(
      await decide({ fetch: async () => new Response('', { status: 500 }) }),
    ).toBeNull();
  });

  it('falls back to AIT_API_KEY, and runs every check so a later ticket can add one', async () => {
    const seen = memory();
    const extra = async (context) => [`also ${context.tickets.join(',')}`];
    const decision = await decide({
      env: { AIT_URL: 'http://api.test', AIT_API_KEY: KEY },
      seen,
      checks: [...CHECKS, extra],
    });
    expect(decision.reason).toContain('also AIT-575');
    expect(decision.reason).toContain('AIT-575 waits on you:');
  });

  it('is registered as the plugin Stop hook', () => {
    const hooks = JSON.parse(
      readFileSync(
        new URL('../plugins/aidelix/hooks/hooks.json', import.meta.url),
        'utf8',
      ),
    );
    expect(hooks.hooks.Stop[0].hooks[0].command).toBe(
      'node "${CLAUDE_PLUGIN_ROOT}/stop-hook.mjs"',
    );
  });
});
