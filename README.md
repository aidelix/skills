# Aidelix skills

Public skills for [Aidelix](https://aidelix.com), the ticket tracker built
for AI coding agents, and plugins that connect Codex and Claude Code to it.

## Connect without a key

For local Codex, run:

```sh
codex mcp add aidelix --url https://api.aidelix.com/v1/mcp
```

Complete browser sign-in. If it does not start, run `codex mcp login aidelix`.
Start a new session and ask it to list your Aidelix projects.

For Claude Code Cloud, add the URL at
[Claude connectors](https://claude.ai/customize/connectors), connect it, and
start a new cloud session. Account policy can restrict connectors.

For hosted Codex tools, use the [hosted plugin guide](docs/hosted-plugin.md).
Local configuration does not transfer to hosted tasks.

## Install the Codex plugin

The Codex package supplies remote MCP and the four skills below. It uses
browser sign-in and needs no local Node bridge or manual key.

After the AIT-246 package reaches the marketplace branch, run:

```sh
codex plugin marketplace add aidelix/skills
codex plugin add aidelix@aidelix-skills
```

For a checkout before merge, replace `aidelix/skills` with its absolute path.
Connect the plugin account when prompted. Start a new session and ask it to
list your Aidelix projects. If you already added a direct server, use one
connection to avoid duplicate tools.

The marketplace is `.agents/plugins/marketplace.json`. The Codex manifest
selects remote HTTP explicitly. The Claude manifest still uses `.mcp.json`
and the existing bridge. Both manifests use the same skill files.

## Install in Claude Code

```
/plugin marketplace add aidelix/skills
/plugin install aidelix@aidelix-skills
```

Then ask Claude: "Connect me to Aidelix." The `aidelix-connect` skill walks
you through the rest.

The plugin adds the Aidelix MCP server and these skills:

| Skill | What it does |
|---|---|
| `aidelix` | Ticket work: read the ticket, claim it, put the key in the branch and commits, record each phase. |
| `aidelix-connect` | Connects the agent: issue an agent key, store it outside the repository, add the server, prove it with `list_projects`. Uses sign-in through the browser when the server offers it. |
| `aidelix-orchestrator` | Watches and runs a set of tickets by release, label, epic or status: a queue in order, one worker per ticket, and a report of what needs a person. |
| `aidelix-file-tickets` | Writes tickets another agent can pick up cold: type, description, acceptance criteria, labels, release, epic, and steps for work only a person can do. |

The Claude bridge needs Node.js 18 or later on the `PATH` (22.21 or later behind
an HTTP proxy), and an agent key in
`AIDELIX_API_KEY`. Set `AIDELIX_URL` for an instance other than
`https://api.aidelix.com`.

## Hear answers without polling (research preview)

The plugin's server is also a Claude Code
[channel](https://code.claude.com/docs/en/channels). Once the agent claims
a ticket, asks a question on one or writes a human ticket's steps, the
server waits on those tickets and pushes what happens on them into the
session: a question answered, a step marked, a status change, a comment. The
agent reads the ticket then, instead of every few minutes.

Channels are a research preview, and this one is not on Anthropic's
allowlist yet, so start Claude Code with it by name:

```
claude --dangerously-load-development-channels plugin:aidelix@aidelix-skills
```

It works in the terminal and in Remote Control, not in cloud sessions.
There, the agent runs `ait watch` in the background, or calls
`list_ticket_events` with `wait`. Set `AIDELIX_CHANNEL=0` to turn the
waiting off.

## Other agents

Each skill is a folder with a `SKILL.md` in `plugins/aidelix/skills/`, in
the [Agent Skills](https://agentskills.io) format. Copy the folders into
your agent's skills directory (for example `.agents/skills/` or
`.claude/skills/`), and connect the MCP server as
`aidelix-connect/SKILL.md` describes.

## Develop

```sh
npm install
npm test             # manifests, skills, and the plugin's bridge
npm run check:tools  # the pinned tool list against a live server (needs a key)
```

`scripts/mcp-tools.json` is the list of tools the server serves. The tests
refuse a skill that names a tool outside it, so update it (with
`check:tools`) when the server adds one.

## License

MIT
