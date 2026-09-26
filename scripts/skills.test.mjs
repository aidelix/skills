import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every skill in this repository is read by agents that act on it, so a
// wrong tool name or a broken manifest misleads every agent that loads it.
const ROOT = new URL('..', import.meta.url).pathname;
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const json = (path) => JSON.parse(read(path));

// The tools the Aidelix MCP server serves. `npm run check:tools` compares this
// list with a live server; update it when the server adds or drops a tool.
const TOOLS = json('scripts/mcp-tools.json');

// Backticked snake_case words that are not tool names.
const NOT_TOOLS = new Set(['in_review', 'payment_required', 'relates_to']);

const marketplace = json('.claude-plugin/marketplace.json');

const plugins = marketplace.plugins.map((entry) => ({
  entry,
  dir: join(ROOT, entry.source),
}));

const skills = plugins.flatMap(({ dir }) =>
  readdirSync(join(dir, 'skills')).map((name) => ({
    name,
    path: join(dir, 'skills', name, 'SKILL.md'),
  })),
);

/** The YAML frontmatter of a SKILL.md, as flat key: value pairs. */
function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return undefined;
  return Object.fromEntries(
    match[1]
      .split('\n')
      .map((line) => /^([a-z-]+):\s*(.*)$/.exec(line))
      .filter(Boolean)
      .map(([, key, value]) => [key, value.trim()]),
  );
}

describe('marketplace', () => {
  it('names itself aidelix-skills', () => {
    expect(marketplace.name).toBe('aidelix-skills');
  });

  it.each(plugins)(
    '$entry.name has a plugin.json of the same name',
    ({ entry, dir }) => {
      const manifest = JSON.parse(
        readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8'),
      );
      expect(manifest.name).toBe(entry.name);
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    },
  );

  it.each(plugins)(
    '$entry.name starts its MCP server from a file it ships',
    ({ dir }) => {
      const mcp = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'));
      for (const server of Object.values(mcp.mcpServers)) {
        for (const arg of server.args ?? []) {
          const file = arg.replace('${CLAUDE_PLUGIN_ROOT}', dir);
          if (file !== arg) expect(existsSync(file)).toBe(true);
        }
      }
    },
  );
});

describe('skills', () => {
  it('ships the four skills the README lists', () => {
    expect(skills.map((s) => s.name).sort()).toEqual([
      'aidelix',
      'aidelix-connect',
      'aidelix-file-tickets',
      'aidelix-orchestrator',
    ]);
    for (const { name } of skills)
      expect(read('README.md')).toContain(`| \`${name}\` |`);
  });

  it.each(skills)(
    '$name has a name that matches its folder and a description',
    ({ name, path }) => {
      const meta = frontmatter(readFileSync(path, 'utf8'));
      expect(meta).toBeDefined();
      expect(meta.name).toBe(name);
      expect(meta.description.length).toBeGreaterThan(40);
      expect(meta.description.length).toBeLessThanOrEqual(1024);
    },
  );

  it.each(skills)('$name names only tools the server serves', ({ path }) => {
    const text = readFileSync(path, 'utf8');
    const named = [...text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map(
      ([, word]) => word,
    );
    const unknown = named.filter(
      (word) => !TOOLS.includes(word) && !NOT_TOOLS.has(word),
    );
    expect(unknown).toEqual([]);
  });

  it.each(skills)(
    '$name never tells an agent to print or commit a key',
    ({ path }) => {
      const text = readFileSync(path, 'utf8');
      const blocks = [...text.matchAll(/```(?:sh|bash)?\n([\s\S]*?)```/g)]
        .map(([, code]) => code)
        .join('\n');
      expect(text).not.toMatch(/echo \$\{?(AIDELIX|AIT)_API_KEY/);
      expect(text).not.toMatch(/ait_[A-Za-z0-9]{16,}/);
      expect(blocks).not.toMatch(/^\s*(printenv|env|set|export -p)\s*$/m);
      expect(blocks).not.toMatch(/cat [^\n]*aidelix\/env/);
    },
  );
});

describe('aidelix-connect', () => {
  it('forbids the commands that print every secret in the environment', () => {
    const text = read('plugins/aidelix/skills/aidelix-connect/SKILL.md');
    expect(text).toMatch(/Never run `env`, `printenv`/);
  });
});

describe('install commands', () => {
  const plugin = marketplace.plugins[0].name;
  const install = `/plugin install ${plugin}@${marketplace.name}`;

  it.each(['README.md', 'plugins/aidelix/skills/aidelix-connect/SKILL.md'])(
    '%s installs from this marketplace',
    (path) => {
      expect(read(path)).toContain('/plugin marketplace add aidelix/skills');
      expect(read(path)).toContain(install);
    },
  );
});
