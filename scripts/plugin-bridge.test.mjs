import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { bridge, config, messages } from '../plugins/aidelix/bridge.mjs';

// The plugin's stdio bridge: it reads AIDELIX_URL and
// AIDELIX_API_KEY first and falls back to AIT_URL and AIT_API_KEY, which a
// plugin's .mcp.json cannot do.
const BRIDGE = new URL('../plugins/aidelix/bridge.mjs', import.meta.url)
  .pathname;
const NEW_KEY = 'ait_new0123456789ab_newnewnewnewnewnewnewnewnewnew';
const OLD_KEY = 'ait_old0123456789ab_oldoldoldoldoldoldoldoldoldold';
const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {} },
};

/** Runs one message through the bridge with a fake fetch. */
async function send(env, message, answer) {
  const calls = [];
  const written = [];
  const logged = [];
  const handle = bridge({
    env,
    fetch: (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return Promise.resolve(
        answer ??
          new Response(
            JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }),
            { headers: { 'content-type': 'application/json' } },
          ),
      );
    },
    write: (m) => written.push(m),
    log: (text) => logged.push(text),
  });
  await handle(JSON.stringify(message));
  return { calls, written, logged, handle };
}

describe('plugin bridge', () => {
  it('reads AIDELIX_URL and AIDELIX_API_KEY before the AIT_ names', async () => {
    const r = await send(
      {
        AIDELIX_URL: 'http://new.test/',
        AIDELIX_API_KEY: NEW_KEY,
        AIT_URL: 'http://old.test',
        AIT_API_KEY: OLD_KEY,
      },
      INIT,
    );
    expect(r.calls[0].url).toBe('http://new.test/v1/mcp');
    expect(r.calls[0].headers.authorization).toBe(`Bearer ${NEW_KEY}`);
    expect(r.written).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
  });

  it('falls back to AIT_URL and AIT_API_KEY when the AIDELIX_ names are unset or blank', async () => {
    for (const blank of [undefined, '', '  ']) {
      const r = await send(
        {
          AIDELIX_URL: blank,
          AIDELIX_API_KEY: blank,
          AIT_URL: 'http://old.test/v1',
          AIT_API_KEY: OLD_KEY,
        },
        INIT,
      );
      expect(r.calls[0].url).toBe('http://old.test/v1/mcp');
      expect(r.calls[0].headers.authorization).toBe(`Bearer ${OLD_KEY}`);
    }
    // Each variable falls back on its own, and no URL means production.
    expect(config({ AIT_API_KEY: OLD_KEY })).toMatchObject({
      endpoint: 'https://api.aidelix.com/v1/mcp',
      key: OLD_KEY,
      keyName: 'AIT_API_KEY',
    });
  });

  it('answers every request with an error that names the key when none is set', async () => {
    const r = await send({ AIDELIX_URL: 'http://new.test' }, INIT);
    expect(r.calls).toHaveLength(0);
    expect(r.written[0].id).toBe(1);
    expect(r.written[0].error.message).toContain(
      'AIDELIX_API_KEY is not set (AIT_API_KEY also works)',
    );
  });

  it('names the variable the key came from when the server refuses it, and never prints the key', async () => {
    const refusal = new Response(
      JSON.stringify({
        error: { code: 'unauthenticated', message: `Bad key ${OLD_KEY}` },
      }),
      { status: 401 },
    );
    const r = await send({ AIT_API_KEY: OLD_KEY }, INIT, refusal);
    const { message } = r.written[0].error;
    expect(message).toContain('Aidelix answered 401');
    expect(message).toContain('Check AIT_API_KEY');
    expect(message).toContain('<AIT_API_KEY>');
    expect(message).not.toContain(OLD_KEY);
    expect(r.logged.join('')).not.toContain(OLD_KEY);

    // A short key that is also a word is not cut out of the bridge's own text.
    const short = await send(
      { AIDELIX_API_KEY: 'wrong' },
      INIT,
      new Response('{}', { status: 401 }),
    );
    expect(short.written[0].error.message).toContain(
      'Check AIDELIX_API_KEY: the key is wrong or revoked.',
    );
  });

  it('writes nothing for a notification, and keeps the session and protocol version', async () => {
    const written = [];
    const calls = [];
    const answers = [
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { protocolVersion: '2025-06-18' },
        }),
        {
          headers: {
            'content-type': 'application/json',
            'mcp-session-id': 'session-1',
          },
        },
      ),
      new Response(null, { status: 202 }),
    ];
    const handle = bridge({
      env: { AIDELIX_API_KEY: NEW_KEY },
      fetch: (url, init) => {
        calls.push(init.headers);
        return Promise.resolve(answers.shift());
      },
      write: (m) => written.push(m),
      log: () => undefined,
    });
    await handle(JSON.stringify(INIT));
    await handle(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    );
    expect(written).toHaveLength(1);
    expect(calls[1]['mcp-session-id']).toBe('session-1');
    expect(calls[1]['mcp-protocol-version']).toBe('2025-06-18');
  });

  it('reads an answer sent as an event stream', () => {
    expect(
      messages(
        'text/event-stream',
        'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n' +
          'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n',
      ),
    ).toEqual([
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', method: 'notifications/progress' },
    ]);
  });

  describe('as a program', () => {
    let server;
    afterEach(() => server?.close());

    it('forwards stdin to the server and its answers to stdout', async () => {
      const seen = [];
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          const message = JSON.parse(body);
          seen.push({
            auth: req.headers.authorization,
            method: message.method,
          });
          if (message.id === undefined) {
            res.writeHead(202).end();
            return;
          }
          res
            .writeHead(200, { 'content-type': 'application/json' })
            .end(
              JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }),
            );
        });
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${server.address().port}`;

      const env = {
        PATH: process.env.PATH,
        AIT_URL: url,
        AIT_API_KEY: OLD_KEY,
      };
      const child = spawn(process.execPath, [BRIDGE], { env });
      let out = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stdin.end(
        [
          INIT,
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        ]
          .map((m) => JSON.stringify(m))
          .join('\n') + '\n',
      );
      const code = await new Promise((resolve) => child.on('close', resolve));

      expect(code).toBe(0);
      const lines = out
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(lines.map((m) => m.id).sort()).toEqual([1, 2]);
      expect(seen[0]).toEqual({
        auth: `Bearer ${OLD_KEY}`,
        method: 'initialize',
      });
      expect(seen).toHaveLength(3);
    });
  });
});
