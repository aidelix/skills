import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHECKS,
  claimedTickets,
  stopDecision,
  wakesAgent,
  watchDecision,
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

  it('blocks again once a list that cleared comes back', async () => {
    const seen = memory();
    expect((await decide({ seen })).decision).toBe('block');
    expect(
      await decide({
        seen,
        fetch: api({ ticketId: TICKET_ID, needsYou: null }).fetch,
      }),
    ).toBeNull();
    expect((await decide({ seen })).decision).toBe('block');
  });

  it('still reads the other tickets when one cannot be read', async () => {
    const transcript = [
      toolUse('mcp__aidelix__claim_ticket', { ticket: 'AIT-9' }),
      TRANSCRIPT,
    ].join('\n');
    const decision = await decide({ readTranscript: () => transcript });
    expect(decision.reason).toContain('AIT-575 waits on you:');
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
    // AIT-551: the same hook watches in the background after the stop.
    expect(hooks.hooks.Stop[0].hooks[1]).toEqual({
      type: 'command',
      command: 'node "${CLAUDE_PLUGIN_ROOT}/stop-hook.mjs" --watch',
      asyncRewake: true,
    });
  });
});

// AIT-551: after the stop, the hook watches the tickets the session handed
// off and wakes it when a person acts.
describe('Stop hook watch', () => {
  const event = (kind, cursor, detail = {}) => ({
    cursor,
    kind,
    ticket: 'AIT-575',
    ticketId: TICKET_ID,
    subjectId: null,
    detail,
    at: '2026-10-24T04:00:00.000Z',
    actor: { humanUserId: 'u', agentId: null },
  });

  /** A fake API whose /events answers come from `pages`, in order. */
  function eventsApi(pages, { status = 'in_review', needsYou = WAITING } = {}) {
    const { calls, fetch: base } = api(needsYou, status);
    const fetch = async (url, init) => {
      if (url.startsWith('http://api.test/v1/events?')) {
        calls.push({ url, auth: init.headers.authorization });
        const page = pages.shift();
        if (page instanceof Error) throw page;
        return Response.json(page ?? { events: [], next: 'end' });
      }
      return base(url, init);
    };
    return { calls, fetch };
  }

  const watch = (over = {}) => {
    let clock = 0;
    return watchDecision({
      input: { session_id: 's', transcript_path: '/t.jsonl' },
      env: ENV,
      readTranscript: () => TRANSCRIPT,
      current: () => true,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      ...over,
    });
  };

  it('starts from now, waits past other events, and wakes the session on one that needs it', async () => {
    const { calls, fetch } = eventsApi([
      { events: [], next: 'c1' },
      { events: [event('comment_added', 'c2')], next: 'c2' },
      {
        events: [event('ci_finished', 'c3', { result: 'failing' })],
        next: 'c3',
      },
    ]);
    const wake = await watch({ fetch });
    const events = calls.filter((call) => call.url.includes('/events'));
    expect(events.map((call) => call.url)).toEqual([
      'http://api.test/v1/events?tickets=AIT-575&wait=25',
      'http://api.test/v1/events?tickets=AIT-575&wait=25&after=c1',
      'http://api.test/v1/events?tickets=AIT-575&wait=25&after=c2',
    ]);
    expect(wake).toContain('a person acted on a ticket you handed off');
    expect(wake).toContain('AIT-575  ci_finished  result=failing');
    // CHECKS add what waits on the agent.
    expect(wake).toContain('finding f-1 (major)');
  });

  it('wakes on an approval with nothing else waiting', async () => {
    const { fetch } = eventsApi(
      [
        { events: [], next: 'c1' },
        { events: [event('approved', 'c2')], next: 'c2' },
      ],
      { needsYou: { ticketId: TICKET_ID, needsYou: null } },
    );
    const wake = await watch({ fetch });
    expect(wake).toContain('AIT-575  approved');
    expect(wake).not.toContain('AIT-575 waits on you:');
  });

  it('tries again after a failed request', async () => {
    const { fetch } = eventsApi([
      { events: [], next: 'c1' },
      new TypeError('fetch failed'),
      { events: [event('review_requested_changes', 'c2')], next: 'c2' },
    ]);
    expect(await watch({ fetch })).toContain('review_requested_changes');
  });

  it('does not watch a ticket that is not in review, when off, or with no key', async () => {
    const pages = () => [
      { events: [], next: 'c1' },
      { events: [event('approved', 'c2')], next: 'c2' },
    ];
    expect(
      await watch({
        fetch: eventsApi(pages(), { status: 'in_progress' }).fetch,
      }),
    ).toBeNull();
    expect(
      await watch({
        fetch: eventsApi(pages()).fetch,
        env: { ...ENV, AIDELIX_STOP_HOOK: '0' },
      }),
    ).toBeNull();
    expect(
      await watch({
        fetch: eventsApi(pages()).fetch,
        env: { ...ENV, AIDELIX_STOP_HOOK_WATCH_HOURS: '0' },
      }),
    ).toBeNull();
    expect(
      await watch({
        fetch: eventsApi(pages()).fetch,
        env: { AIDELIX_URL: 'http://api.test' },
      }),
    ).toBeNull();
  });

  it('gives up at its deadline, and when a newer stop takes over', async () => {
    let clock = 0;
    const quiet = {
      calls: 0,
      fetch: async (url, init) => {
        if (url.includes('/events')) {
          quiet.calls += 1;
          clock += 25_000;
          return Response.json({ events: [], next: 'c1' });
        }
        return eventsApi([]).fetch(url, init);
      },
    };
    expect(
      await watch({
        fetch: quiet.fetch,
        now: () => clock,
        env: { ...ENV, AIDELIX_STOP_HOOK_WATCH_HOURS: '1' },
      }),
    ).toBeNull();
    expect(quiet.calls).toBe(144);

    let mine = true;
    const { fetch } = eventsApi([
      { events: [], next: 'c1' },
      { events: [event('approved', 'c2')], next: 'c2' },
    ]);
    const handover = async (url, init) => {
      const res = await fetch(url, init);
      if (url.includes('after=c1')) mine = false;
      return res;
    };
    expect(await watch({ fetch: handover, current: () => mine })).toBeNull();
  });

  it('reads the same events as ait watch --until approved,needs-me', () => {
    expect(wakesAgent(event('approved'))).toBe(true);
    expect(wakesAgent(event('review_thread_waiting'))).toBe(true);
    expect(wakesAgent(event('question_answered'))).toBe(true);
    expect(wakesAgent(event('rejected'))).toBe(true);
    expect(wakesAgent(event('ci_finished', 'c', { result: 'passing' }))).toBe(
      false,
    );
    expect(wakesAgent(event('status_changed'))).toBe(false);
  });
});
