---
name: aidelix-connect
description: Use when a person wants to connect this agent to Aidelix, when the Aidelix tools are missing or fail with unauthenticated, or when they ask how to set up the Aidelix MCP server in Codex, Claude Code, cloud sessions, or another MCP client. Prefers browser sign-in and distinguishes local setup from hosted connections.
---

# Connect to Aidelix

Aidelix serves an MCP server at `<API URL>/v1/mcp`. Production is
`https://api.aidelix.com`, and its board is `https://app.aidelix.com`. A
self-hosted instance has its own URLs; ask the person if they name one.

Work through the steps in order and stop at the first one that already
holds. Tell the person which step you are on in one line.

## Rules for the key

An agent key acts for the person who issued it. Treat it like a password:

- Never ask the person to paste the key into the chat.
- Never print it, echo it, or put it in a command line that you run.
- Never write it into the repository, into `.mcp.json`, or into any file
  that git tracks.
- Never run `env`, `printenv`, `set` or `export -p`, even filtered: they
  print every secret in the environment, not only this one.
- To check that a key is set, run exactly this, which prints only `set` or
  `missing`:
  `[ -n "${AIDELIX_API_KEY:-$AIT_API_KEY}" ] && echo set || echo missing`.
  Its answer is final. If it says `missing`, the key is not in this
  environment; go on to step 2.

## 1. Is it already connected?

If you have the Aidelix tools, call `list_projects`.

- It shows projects: the connection works. Say so and stop.
- It fails with `unauthenticated`: the key is wrong, revoked or expired. Go
  to step 3 to issue a new one.
- There are no Aidelix tools: go on to step 2.

In local Codex and Claude Code, `/mcp` shows each server and its state.
Identify the platform before changing its configuration. A local connection
does not configure a hosted session.

## 2. Can the person sign in without a key?

Some Aidelix servers let a person sign in through the browser (OAuth)
instead of using a key. Check whether this one does:

```sh
curl -s -o /dev/null -w '%{http_code}\n' "${AIDELIX_URL:-${AIT_URL:-https://api.aidelix.com}}/.well-known/oauth-protected-resource"
```

- `200`: sign-in is offered. Use the sign-in path below and skip the key.
- A network error or server error: report it. Do not infer that browser sign-in is unavailable.
- A confirmed server without OAuth support: use a key in a local client or automated job.

### Codex on a local host

For a direct connection, run:

```sh
codex mcp add aidelix --url "${AIDELIX_URL:-${AIT_URL:-https://api.aidelix.com}}/v1/mcp"
```

Let the person complete browser sign-in. If sign-in does not start, run
`codex mcp login aidelix`. Start a new session, then call `list_projects`.
The CLI, desktop app, and IDE share configuration on the same host.

If the Codex Aidelix plugin already supplies the server, authenticate that
server through the plugin instead. Do not add a duplicate connection.
The Codex plugin uses remote HTTP and does not need Node or an agent key.

### Claude Code on a local host

If Aidelix is already connected in the person's Claude account, use that
connector with their Claude subscription login. API-key and third-party
provider sessions do not load these account connectors.

For a direct local connection, run:

```sh
claude mcp add --transport http --scope user aidelix "${AIDELIX_URL:-${AIT_URL:-https://api.aidelix.com}}/v1/mcp"
```

The person runs `/mcp`, selects Aidelix, and chooses Authenticate. They sign
in and allow access. Go to step 6.

The Claude plugin bridge still needs a key. Use either that bridge or the
direct connection. Explain an existing duplicate before removing it.

### Claude Code Cloud, Claude web, and Claude desktop

Open https://claude.ai/customize/connectors. Add the instance's MCP endpoint
as a custom connector. Connect it, sign in, and allow access in Aidelix.
For Claude Code Cloud, start a new session with the same account.

The cloud host supplies account connectors. Organization policy can restrict
them, and Team or Enterprise accounts can require an admin to add one.
A local plugin or terminal command does not configure this cloud connection.
Call `list_projects` in the new session before ticket work.

### Codex Cloud and hosted ChatGPT Work

Use a hosted Aidelix plugin connection from the workspace or plugin directory.
Install it, connect its account, and allow access in Aidelix. Start a new
task and call `list_projects`. Do not claim success until that call works.

A local repository plugin does not publish a hosted connection. If the plugin
is unavailable, the person needs an admin to publish it. Use the distribution
guide at https://github.com/aidelix/skills/blob/main/docs/hosted-plugin.md.
The package uses production. Another instance needs its own endpoint.

Current cloud environments can provide a network secret for shell access.
That credential reaches only approved HTTPS destinations through a proxy.
This is not native MCP tool discovery. Do not replace a failed connection
with an untested shell recipe or print the secret to diagnose it.

Legacy Codex Cloud exposes secrets only during setup. Setup exports do not
reach its agent phase. Do not persist tokens in repository or cached files.

Sources: https://learn.chatgpt.com/docs/extend/mcp?surface=cli,
https://learn.chatgpt.com/docs/environments/cloud-environments,
https://learn.chatgpt.com/docs/environments/cloud-environment,
and https://code.claude.com/docs/en/mcp.

## 3. Issue an agent key

The person does this on the board; you cannot:

1. Sign in at `https://app.aidelix.com`.
2. Open Agents (`/agents`) and create an agent for this tool, for example
   "Claude Code on my laptop".
3. Open the agent, pick themselves as the person the key acts for, and
   click Issue key.
4. Copy the key. The board shows it once.

Wait for the person to say they have the key. Do not ask them to show it.

## 4. Store the key outside the repository

Offer to set up a private env file, and do it only with a yes:

```sh
mkdir -p ~/.config/aidelix
[ -f ~/.config/aidelix/env ] || printf 'export AIDELIX_API_KEY=""\n' > ~/.config/aidelix/env
chmod 600 ~/.config/aidelix/env
```

Then add one line to their shell profile (`~/.zshrc` or `~/.bashrc`) if it
is not there yet:

```sh
[ -f ~/.config/aidelix/env ] && . ~/.config/aidelix/env
```

Ask the person to open `~/.config/aidelix/env` in their editor and paste
the key between the quotes. For an instance other than production, they
add `export AIDELIX_URL="https://..."` there too (the API URL, without
`/v1`).

For a cloud session, use the platform-specific path in step 2. Do not assume
that a shell profile or local environment reaches a hosted task.

The older names `AIT_API_KEY` and `AIT_URL` still work when the
`AIDELIX_` names are unset.

## 5. Add the server

Pick the one that fits the client.

**Claude Code, with the optional bridge plugin.** The plugin adds the server
and the Aidelix skills:

```
/plugin marketplace add aidelix/skills
/plugin install aidelix@aidelix-skills
```

The plugin's server is a small Node script, so Node.js 18 or later must be
on the `PATH` (`node --version`); behind an HTTP proxy it needs Node 22.21
or later, which reads the proxy variables. It reads `AIDELIX_API_KEY` and
`AIDELIX_URL` from the environment Claude Code starts in, so the person
must open a new terminal (to load the profile) and restart Claude Code.

**Claude Code, without the plugin.** The person runs this themselves in a
new terminal, because it reads the key from their environment:

```sh
claude mcp add --transport http --scope user aidelix "${AIDELIX_URL:-${AIT_URL:-https://api.aidelix.com}}/v1/mcp" \
  --header "Authorization: Bearer ${AIDELIX_API_KEY:-$AIT_API_KEY}"
```

This writes the key into `~/.claude.json`, which must stay private.

**Codex on a local host.** After the person stores the key, run:

```sh
codex mcp add aidelix --url "${AIDELIX_URL:-${AIT_URL:-https://api.aidelix.com}}/v1/mcp" --bearer-token-env-var AIDELIX_API_KEY
```

Use `AIT_API_KEY` as the variable name only when the person uses that older
name. Start Codex from the shell that contains the variable. The configuration
stores the variable name, not its value. Prefer browser sign-in for desktop
launchers that do not inherit shell variables.

**Any other MCP client** (Cursor, Windsurf, and others). Most take a JSON
file of this shape; the client's docs say where it lives (Cursor:
`~/.cursor/mcp.json`). The person fills in the key themselves:

```json
{
  "mcpServers": {
    "aidelix": {
      "type": "http",
      "url": "https://api.aidelix.com/v1/mcp",
      "headers": { "Authorization": "Bearer <agent key>" }
    }
  }
}
```

Use the user-level file, never one inside the repository.

## 6. Prove it

After the restart, call `list_projects`. Show the project keys and names.

- `unauthenticated`: the key was mistyped or revoked. Issue a new one
  (step 3).
- No Aidelix tools: in Claude Code, `/mcp` names the failure. The plugin's
  message says which variable to fix. A missing `node` shows as a failed
  start.
- `payment_required`: the organisation's plan is at a limit. Only a person
  can lift it; show them `details.remedy`.

## 7. Tell the agent which project

If the repository's `CLAUDE.md` or `AGENTS.md` does not name an Aidelix
project yet, offer to add this block, with the key of the project the
person picks from `list_projects`:

```md
## Tickets

Tickets for this repository live in Aidelix, project key `ABC`. Use the
Aidelix MCP tools for all ticket work.
```

The server sends its own instructions for ticket work when it connects, so
the block needs nothing more.
