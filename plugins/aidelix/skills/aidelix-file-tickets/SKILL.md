---
name: aidelix-file-tickets
description: Use when a person asks to file, write up or break down work in Aidelix, for example "file a bug for this", "turn this spec into tickets", "split this feature up", or when you find work outside the ticket you are on. Writes tickets an agent or a person can pick up cold, with a clear description, acceptance criteria, type, labels, release and epic.
---

# File Aidelix tickets

A ticket is a spec that a different agent, with none of this conversation,
will pick up and work. Write it so that agent needs nothing else.

This skill needs the Aidelix MCP tools. If they are missing, use the
`aidelix-connect` skill first.

## 1. Check before you file

- Find the project key: the repository's `CLAUDE.md` or `AGENTS.md`, or
  `list_projects`.
- Look for a ticket that already covers it: `find_tickets` with the status
  and label that fit, and read likely ones with `get_ticket`. If one exists,
  add to it with `add_comment` instead of filing a duplicate. Change its
  description only when the person asks: send the whole new text with
  `update_ticket`, then say what changed with `add_comment`. If you file a
  new ticket anyway, link it with `link_tickets`: the new ticket as
  `ticket`, type `duplicates`, the existing one as `toTicket`.

## 2. Pick the type

| Type | For |
|---|---|
| `bug` | Something that works differently from how it should. |
| `feature` | New behaviour a person or an agent will notice. |
| `chore` | Upkeep with no change in behaviour: upgrades, cleanup, CI. |
| `docs` | Documentation only. |
| `spike` | A question to answer by research or a prototype, with a write-up. |
| `brainstorm` | A problem to turn into tickets. It ends in new tickets, never code. |
| `brain` | Knowledge to write into the brain: a convention, how a subsystem works, how to deploy. It ends in brain pages, never code. |
| `epic` | A container for several tickets toward one goal. |
| `human` | Work only a person can do: make an account, pay, set a secret, click a button in another product. |

## 3. Write the description: what and why

The description is Markdown. Cover, in this order and only what applies:

1. **What** is wrong or wanted, in one or two sentences.
2. **Why** it matters: who is affected and what it costs them.
3. **Context** the next agent cannot find on its own: links, the error
   text, the file and line, what you already tried or ruled out.
4. For a bug: the steps to reproduce it, what happened, and what should have
   happened.
5. What is **out of scope**, when the edge is not obvious.

State facts you checked as facts, and say which parts are guesses. Leave
out the history of how you got there.

A screenshot helps a person more than a paragraph. After `create_ticket`:
`request_upload` with the ticket, PUT the file to `putUrl` with exactly the
`putHeaders` it returns, `complete_upload`, then `update_ticket` with the
upload's Markdown in the description.

## 4. Write the acceptance criteria: how to tell it is done

`acceptanceCriteria` is a Markdown checklist, one criterion per item:

```md
- [ ] A signed-out visitor who opens /tickets/ABC-1 lands on sign-in and returns to the ticket afterwards.
- [ ] The API answers 401 with code unauthenticated for a request without a session.
```

Each criterion is something a person or an agent can check and see pass or
fail, without reading the code. Name the observable result, not the
implementation. Three to seven is usual; more means the ticket should be
split.

For a `brain` ticket, the criteria name the pages to write and the
questions each one must answer for an agent with no context.

Leave the criteria empty on a `brainstorm` or `spike` only when the
question itself is the whole ticket, and say what the answer must contain
in the description instead.

## 5. Place it

- **Priority**: `highest`, `high`, `medium` (the default), `low` or
  `lowest`. Use what the person said; otherwise leave the default.
- **Labels**: `list_labels`, then `set_labels` after `create_ticket`. No
  tool creates a label; if the one you need does not exist, say so.
- **Release**: `list_releases`, then `releaseId` on `create_ticket`. Only
  when the person named a release or the work plainly belongs to one.
- **Epic**: `parentTicketId` set to the epic's id. Only an epic can be a
  parent.
- **Assignee**: leave it empty unless the person named someone. Whoever
  claims the ticket assigns themselves.

## 6. Split large work

When the work is more than one pull request, file an `epic` for the goal
and one ticket per slice inside it. Each slice:

- delivers something that can be reviewed and shipped on its own,
- has its own description and acceptance criteria,
- names what it needs from the other slices.

Connect the order with `link_tickets`: `blocks` from the ticket that must
land first to the one that waits on it. Use `relates_to` for tickets that
touch the same area but do not wait on each other.

## 7. Work only a person can do

File a `human` ticket and write its steps with `set_instructions`: one
action to a step, with the exact value, command or link. Link it to the
ticket that waits on it with `blocks`. Never put a secret in a step; say
where the person gets it and where it goes.

## 8. Confirm

After filing, tell the person each new key and title, one line each, with
the link to the board. If you filed work you found while on another ticket,
also `add_comment` on that ticket naming the new key.
