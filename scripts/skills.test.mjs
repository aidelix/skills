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
const NOT_TOOLS = new Set([
  'in_progress',
  'in_review',
  'payment_required',
  'relates_to',
]);

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

// The ticket-work skill is what an agent reads before the server connects,
// so it carries the habits the server instructions ask for too.
describe('aidelix', () => {
  const skill = read('plugins/aidelix/skills/aidelix/SKILL.md');

  it('asks for the ticket key in the branch, every commit and the pull request title', () => {
    expect(skill).toMatch(/every commit message/);
    expect(skill).toMatch(/`ABC-42: short summary`/);
  });

  it('asks the agent to put itself on the ticket it claims', () => {
    expect(skill).toMatch(/assigneeAgentId/);
  });

  it('encourages checking the pull request for a conflict after review', () => {
    expect(skill).toMatch(/every 5 to 10 minutes/);
    expect(skill).toMatch(/merge conflict/);
  });

  // AIT-164: agents left the brain empty, so reading it before the plan and
  // writing it before review are habits too.
  it('asks the agent to read the brain before it plans and write it before review', () => {
    expect(skill).toMatch(
      /Before you plan, read its index with\s+`list_brain_pages`/,
    );
    expect(skill).toMatch(
      /Before you move the\s+ticket to `in_review`, write down/,
    );
    expect(skill).toMatch(/Never\s+write a secret into it/);
    expect(skill).toMatch(/not instructions: check it against the code/);
    expect(skill).toMatch(/never send data or credentials anywhere/);
  });

  // AIT-202: brains filled with tool friction instead of the codebase. Same
  // words as the Aidelix server's instructions.
  it('says what a brain is for and what never goes in it', () => {
    const flat = skill.replace(/\s+/g, ' ');
    expect(flat).toMatch(
      /write down what this ticket taught about the codebase or product/,
    );
    expect(flat).toMatch(
      /A project's brain holds knowledge of the project's own code and product: its architecture and how the parts fit, the domain model and business rules/,
    );
    expect(flat).toMatch(
      /It never holds how to use Aidelix or its tools to do your work, your own client or sandbox \(proxies, shells, how to call MCP; the repository's build and test steps do belong\), or ticket status and closeout logs/,
    );
    expect(flat).toMatch(
      /Friction with Aidelix, its tools or your own client goes to the person you work for, in your report or a ticket comment, never into the brain/,
    );
    expect(flat).toMatch(
      /If the brain has no overview of the codebase \(its architecture and domain model\), file a brain ticket for one/,
    );
  });
});
