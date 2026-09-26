#!/usr/bin/env node
// Connects Claude Code to the Aidelix MCP server.
//
// Claude Code talks to this script over stdio, and the script forwards each
// message to `<url>/v1/mcp` over HTTP. It exists so the plugin can read
// AIDELIX_URL and AIDELIX_API_KEY first and fall back to AIT_URL and
// AIT_API_KEY. A plugin's `.mcp.json` cannot: Claude Code expands
// `${VAR:-default}` there in one pass, so a nested default stays text, and it
// runs a `headersHelper` with every `*_API_KEY` variable removed. A stdio
// server gets the whole environment.
//
// No dependencies: it runs on Node 18 or later.

import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const DEFAULT_URL = 'https://api.aidelix.com';
const TIMEOUT_MS = 60_000;

/** `AIDELIX_<suffix>`, or `AIT_<suffix>` when that is unset or blank. */
export function setting(env, suffix) {
  for (const name of [`AIDELIX_${suffix}`, `AIT_${suffix}`]) {
    const value = env[name]?.trim();
    if (value) return { name, value };
  }
  return undefined;
}

/** The MCP endpoint, and the key or the reason there is none. */
export function config(env) {
  const url = setting(env, 'URL');
  const base = (url?.value ?? DEFAULT_URL)
    .replace(/\/+$/, '')
    .replace(/\/v1$/, '');
  const key = setting(env, 'API_KEY');
  return {
    endpoint: `${base}/v1/mcp`,
    key: key?.value,
    keyName: key?.name,
    urlName: url?.name,
  };
}

/** The JSON-RPC messages in an HTTP answer: plain JSON, or an event stream. */
export function messages(contentType, text) {
  if (!text.trim()) return [];
  if (!contentType.includes('text/event-stream')) {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  const found = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data) found.push(JSON.parse(data));
  }
  return found;
}

/**
 * Runs the bridge. `write` receives each message for Claude Code. Returns a
 * function that takes one line from Claude Code and settles when its answer
 * is written.
 */
export function bridge({ env, fetch, write, log }) {
  const { endpoint, key, keyName, urlName } = config(env);
  // Text from the network can quote the key. Our own words never do, so only
  // that text is redacted, or a short key would mangle the sentence around it.
  const redact = (text) => (key ? text.split(key).join(`<${keyName}>`) : text);
  let sessionId;
  let protocolVersion;

  const fail = (id, message) => {
    log(`aidelix: ${message}`);
    if (id !== undefined && id !== null) {
      write({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message },
      });
    }
  };

  return async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return log('aidelix: ignored a line that is not JSON');
    }
    const id = message.id;
    if (!key) {
      return fail(
        id,
        'AIDELIX_API_KEY is not set (AIT_API_KEY also works). Issue an agent key on the Aidelix board, set it, and restart Claude Code.',
      );
    }

    const headers = {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion;

    let response;
    let text;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: line,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      text = await response.text();
    } catch (err) {
      const where = urlName ? ` (${urlName})` : '';
      return fail(
        id,
        `No answer from ${endpoint}${where}: ${redact(err.message)}`,
      );
    }

    if (!response.ok) {
      let reason = text.slice(0, 500);
      try {
        const body = JSON.parse(text);
        reason = body.error?.message ?? reason;
      } catch {
        // Keep the raw text.
      }
      const hint =
        response.status === 401
          ? ` Check ${keyName}: the key is wrong or revoked.`
          : '';
      return fail(
        id,
        `Aidelix answered ${response.status}: ${redact(reason)}${hint}`,
      );
    }

    sessionId = response.headers.get('mcp-session-id') ?? sessionId;
    let answers;
    try {
      answers = messages(response.headers.get('content-type') ?? '', text);
    } catch {
      return fail(
        id,
        `Aidelix sent an answer that is not JSON (${response.status}).`,
      );
    }
    for (const answer of answers) {
      if (message.method === 'initialize' && answer.result?.protocolVersion) {
        protocolVersion = answer.result.protocolVersion;
      }
      write(answer);
    }
  };
}

// Run as a program: one JSON-RPC message per line on stdin and stdout.
const main = process.argv[1] && pathToFileURL(realpathSync(process.argv[1]));
if (main && import.meta.url === main.href) {
  const handle = bridge({
    env: process.env,
    fetch: globalThis.fetch,
    write: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
    log: (text) => process.stderr.write(`${text}\n`),
  });
  // The first message is initialize. Later ones wait for it, so they carry
  // the session it opens, and then run side by side.
  let first;
  const pending = new Set();
  createInterface({ input: process.stdin })
    .on('line', (line) => {
      const run = first
        ? first.then(() => handle(line))
        : handle(line).catch((err) =>
            process.stderr.write(`aidelix: ${err.message}\n`),
          );
      first ??= run;
      pending.add(run);
      void run.finally(() => pending.delete(run));
    })
    .on('close', () => {
      void Promise.allSettled([...pending]).then(() => process.exit(0));
    });
}
