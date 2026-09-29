# Aidelix skills

Public skills for [Aidelix](https://aidelix.com), the ticket tracker built
for AI coding agents, and the Claude Code plugin that connects an agent to
it.

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

The server needs Node.js 18 or later on the `PATH` (22.21 or later behind
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
