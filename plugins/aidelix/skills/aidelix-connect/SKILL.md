---
name: aidelix-connect
description: Use when a person wants to connect this agent to Aidelix, when the Aidelix tools are missing or fail with unauthenticated, or when they ask how to set up the Aidelix MCP server in Claude Code, Cursor or another MCP client. Walks through getting an agent key, storing it safely, adding the server and proving the connection.
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

In Claude Code, `/mcp` shows each server and why a failed one failed.

## 2. Can the person sign in without a key?

Some Aidelix servers let a person sign in through the browser (OAuth)
instead of using a key. Check whether this one does:

```sh
curl -s -o /dev/null -w '%{http_code}\n' "${AIDELIX_URL:-${AIT_URL:-https://api.aidelix.com}}/.well-known/oauth-protected-resource"
```

- `200`: sign-in is offered. Use the sign-in path below and skip the key.
- Anything else: this server takes a key. Go to step 3.

### The sign-in path

Claude Code:

```sh
claude mcp add --transport http --scope user aidelix "${AIDELIX_URL:-${AIT_URL:-https://api.aidelix.com}}/v1/mcp"
```

Then the person runs `/mcp` in Claude Code, picks `aidelix`, and chooses
Authenticate. A browser opens on the Aidelix sign-in page. After they sign
in, the session is connected. Go to step 6.

Claude on the web or the desktop app: Settings, Connectors, Add custom
connector, paste `https://api.aidelix.com/v1/mcp`, then Connect and sign in.

If the plugin is installed, its own server stays failed without a key.
That is harmless; the server you added by sign-in is the one to use.

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

In a cloud session, such as Claude Code on the web, there is no profile:
the person adds `AIDELIX_API_KEY` to the environment's variables in its
settings, and starts a new session, which is the first to see it.

The older names `AIT_API_KEY` and `AIT_URL` still work when the
`AIDELIX_` names are unset.

## 5. Add the server

Pick the one that fits the client.

**Claude Code, with the plugin (recommended).** The plugin adds the server
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
