#!/usr/bin/env node
// Compares scripts/mcp-tools.json with the tools a live Aidelix server
// serves. Needs AIDELIX_API_KEY (or AIT_API_KEY); AIDELIX_URL picks the
// instance. Exits 1 and names the difference when they drift.
import { readFileSync } from 'node:fs';
import { config, messages } from '../plugins/aidelix/bridge.mjs';

const { endpoint, key } = config(process.env);
if (!key) {
  console.error('Set AIDELIX_API_KEY to an agent key first.');
  process.exit(1);
}
const live = [];
let cursor;
do {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: cursor ? { cursor } : {},
    }),
  });
  if (!response.ok) {
    console.error(`${endpoint} answered ${response.status}.`);
    process.exit(1);
  }
  const [answer] = messages(
    response.headers.get('content-type') ?? '',
    await response.text(),
  );
  if (!answer?.result) {
    console.error(`The server refused tools/list: ${JSON.stringify(answer)}`);
    process.exit(1);
  }
  live.push(...answer.result.tools.map((t) => t.name));
  cursor = answer.result.nextCursor;
} while (cursor);
live.sort();
const pinned = JSON.parse(
  readFileSync(new URL('./mcp-tools.json', import.meta.url), 'utf8'),
).sort();
const added = live.filter((t) => !pinned.includes(t));
const dropped = pinned.filter((t) => !live.includes(t));
if (added.length || dropped.length) {
  console.error(`New on the server: ${added.join(', ') || 'none'}`);
  console.error(`Gone from the server: ${dropped.join(', ') || 'none'}`);
  process.exit(1);
}
console.log(`${live.length} tools, in step with ${endpoint}`);
