import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claims,
  readLogs,
  reportId,
  reportUsage,
  usageBySession,
} from '../plugins/aidelix/usage-report.mjs';

// The plugin's usage report (AIT-1071): token counts by model for each
// work session the agent claimed, from the session's own transcript.
const KEY = 'ait_0123456789abcdef_secretsecretsecretsecretsecretsecretsecr';
const ENV = { AIDELIX_URL: 'http://api.test/', AIDELIX_API_KEY: KEY };
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';

const claimUse = (id, ticket) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-11-23T15:00:00Z',
    message: {
      id: `use-${id}`,
      model: 'claude-opus-5-5',
      content: [
        {
          type: 'tool_use',
          id,
          name: 'mcp__plugin_aidelix_aidelix__claim_ticket',
          input: { ticket },
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });

const claimResult = (id, at, session, extra = {}) =>
  JSON.stringify({
    type: 'user',
    timestamp: at,
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content: [
            {
              type: 'text',
              text: JSON.stringify({ id: session, ticketId: 'x' }),
            },
          ],
          ...extra,
        },
      ],
    },
  });

const turn = (id, at, model, usage) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: at,
    message: {
      id,
      model,
      content: [{ type: 'text', text: 'secret reply' }],
      usage,
    },
  });

describe('claims', () => {
  it('finds each work session claimed, at its answer, once', () => {
    const log = [
      claimUse('c1', 'AIT-1'),
      claimResult('c1', '2026-11-23T15:00:01Z', S1),
      claimUse('c2', 'AIT-2'),
      claimResult('c2', '2026-11-23T16:00:00Z', S2),
      claimUse('c3', 'AIT-1'),
      claimResult('c3', '2026-11-23T17:00:00Z', S1),
      claimUse('c4', 'AIT-3'),
      claimResult('c4', '2026-11-23T18:00:00Z', 'not-a-uuid'),
      claimUse('c5', 'AIT-4'),
      claimResult('c5', '2026-11-23T18:00:00Z', S2, { is_error: true }),
      'not json',
    ].join('\n');
    expect(claims(log)).toEqual([
      { sessionId: S1, at: Date.parse('2026-11-23T15:00:01Z') },
      { sessionId: S2, at: Date.parse('2026-11-23T16:00:00Z') },
    ]);
  });
});

describe('usageBySession', () => {
  const sessionClaims = [
    { sessionId: S1, at: Date.parse('2026-11-23T15:00:00Z') },
    { sessionId: S2, at: Date.parse('2026-11-23T16:00:00Z') },
  ];

  it('gives each turn to the session claimed last before it, once per reply', () => {
    const main = [
      turn('m0', '2026-11-23T14:00:00Z', 'claude-opus-5-5', {
        input_tokens: 999,
        output_tokens: 999,
      }),
      turn('m1', '2026-11-23T15:10:00Z', 'claude-opus-5-5', {
        input_tokens: 10,
        output_tokens: 1,
        cache_creation_input_tokens: 30,
        cache_creation: { ephemeral_1h_input_tokens: 10 },
      }),
      turn('m1', '2026-11-23T15:10:01Z', 'claude-opus-5-5', {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 30,
        cache_creation: { ephemeral_1h_input_tokens: 10 },
      }),
      turn('m2', '2026-11-23T16:30:00Z', 'claude-opus-5-5', {
        input_tokens: 5,
        output_tokens: 5,
        cache_read_input_tokens: 100,
      }),
      turn('syn', '2026-11-23T16:31:00Z', '<synthetic>', { output_tokens: 9 }),
      '{broken',
    ].join('\n');
    const sub = turn('s1', '2026-11-23T15:20:00Z', 'claude-haiku-5-5', {
      input_tokens: 3,
      output_tokens: 4,
    });
    const reports = usageBySession([main, sub], sessionClaims);
    expect(reports).toEqual([
      {
        sessionId: S1,
        at: Date.parse('2026-11-23T15:00:00Z'),
        lastTurnAt: Date.parse('2026-11-23T15:20:00Z'),
        models: {
          'claude-opus-5-5': {
            inputTokens: 10,
            outputTokens: 20,
            cacheReadTokens: 0,
            cacheWriteTokens: 30,
            cacheWrite1hTokens: 10,
          },
          'claude-haiku-5-5': {
            inputTokens: 3,
            outputTokens: 4,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        },
      },
      {
        sessionId: S2,
        at: Date.parse('2026-11-23T16:00:00Z'),
        lastTurnAt: Date.parse('2026-11-23T16:30:00Z'),
        models: {
          'claude-opus-5-5': {
            inputTokens: 5,
            outputTokens: 5,
            cacheReadTokens: 100,
            cacheWriteTokens: 0,
          },
        },
      },
    ]);
  });
});

describe('reportUsage', () => {
  const transcript = [
    claimUse('c1', 'AIT-1'),
    claimResult('c1', '2026-11-23T15:00:00Z', S1),
    turn('m1', '2026-11-23T15:00:10Z', 'claude-opus-5-5', {
      input_tokens: 3,
      output_tokens: 4,
    }),
  ].join('\n');
  const input = {
    session_id: 'claude-1',
    transcript_path: '/home/me/.claude/projects/p/claude-1.jsonl',
  };

  function fakeFetch(status = 201) {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url, init });
      return new Response('{}', { status });
    };
    return { calls, fetch };
  }

  it('posts numbers only, under a stable id, to the session', async () => {
    const { calls, fetch } = fakeFetch();
    const sent = await reportUsage({
      input,
      env: ENV,
      fetch,
      readLogs: () => [transcript],
    });
    expect(sent).toBe(1);
    expect(calls[0].url).toBe(`http://api.test/v1/sessions/${S1}/usage`);
    expect(calls[0].init.headers.authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(calls[0].init.body);
    expect(body).toEqual({
      reportId: reportId('claude-1', S1, Date.parse('2026-11-23T15:00:00Z')),
      source: 'claude_hook',
      models: {
        'claude-opus-5-5': {
          inputTokens: 4,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
      durationMs: 10_000,
    });
    const text = calls[0].init.body;
    for (const word of ['secret reply', 'AIT-1', '/home/me', 'claude-1'])
      expect(text).not.toContain(word);
  });

  it('sends nothing when off, without a key, or with no claim', async () => {
    for (const env of [{ ...ENV, AIDELIX_REPORT_USAGE: '0' }, {}]) {
      const { calls, fetch } = fakeFetch();
      await reportUsage({ input, env, fetch, readLogs: () => [transcript] });
      expect(calls).toHaveLength(0);
    }
    const { calls, fetch } = fakeFetch();
    await reportUsage({
      input,
      env: ENV,
      fetch,
      readLogs: () => [
        turn('m', '2026-11-23T15:00:00Z', 'claude-opus-5-5', {}),
      ],
    });
    expect(calls).toHaveLength(0);
  });

  it('fails open on an unreadable transcript or a failed request', async () => {
    const { fetch } = fakeFetch();
    await expect(
      reportUsage({
        input,
        env: ENV,
        fetch,
        readLogs: () => {
          throw new Error('gone');
        },
      }),
    ).resolves.toBe(0);
    await expect(
      reportUsage({
        input,
        env: ENV,
        fetch: async () => {
          throw new Error('offline');
        },
        readLogs: () => [transcript],
      }),
    ).resolves.toBe(0);
    await expect(
      reportUsage({
        input,
        env: ENV,
        fetch: fakeFetch(500).fetch,
        readLogs: () => [transcript],
      }),
    ).resolves.toBe(0);
  });
});

describe('readLogs', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aidelix-usage-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the transcript, then its subagents in order', () => {
    const path = join(dir, 'abc.jsonl');
    writeFileSync(path, 'main');
    expect(readLogs(path)).toEqual(['main']);
    mkdirSync(join(dir, 'abc', 'subagents'), { recursive: true });
    writeFileSync(join(dir, 'abc', 'subagents', 'b.jsonl'), 'b');
    writeFileSync(join(dir, 'abc', 'subagents', 'a.jsonl'), 'a');
    writeFileSync(join(dir, 'abc', 'subagents', 'x.txt'), 'x');
    expect(readLogs(path)).toEqual(['main', 'a', 'b']);
  });
});
