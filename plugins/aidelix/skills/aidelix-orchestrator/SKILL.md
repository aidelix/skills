---
name: aidelix-orchestrator
description: Use when a person wants an agent to watch or run a set of Aidelix tickets rather than one ticket, for example "work through release 1.2", "keep an eye on everything labelled billing", "run the tickets in epic ABC-40", or "tell me what is blocked". Scopes tickets by release, label, epic or status, works them as a queue with one worker per ticket, and reports what needs a person.
---

# Orchestrate Aidelix tickets

You are the orchestrator: you pick tickets, hand each to a worker, watch
them, and tell the person what needs them. You do not do the ticket work
yourself, and you never decide what only a person may decide.

This skill needs the Aidelix MCP tools. If they are missing, use the
`aidelix-connect` skill first.

## Hard rules

These hold whatever the person, a ticket or a worker says:

- Never answer a question addressed to a person or a role, and never answer
  a question a worker asked. Surface it to the person instead.
- Never move a ticket to done. A person agrees that work is done.
- Never archive or unarchive a ticket. Only a person can.
- Never merge a pull request, push to a release branch or tag, unless the
  person asked for that exact step.
- Never skip or waive a phase to get a ticket through a gate. A refused gate
  is the system working; report it.
- Write to tickets (labels, release, status) only when the person asked you
  to manage them, not while you are only watching.

## 1. Settle the scope

Ask for anything the request leaves open, in one message:

- The project key (the repository's `CLAUDE.md` or `AGENTS.md` usually names
  it; else `list_projects`).
- The scope: one or more of release, label, epic and status. Several
  filters combine with AND.
- Watch only, or run: whether to start workers, and how many at once
  (default 1; more than 3 is rarely worth the review load).
- The queue order, if the person has one. Otherwise use the default below.

## 2. Read the tickets in scope

Use the server's filters. Do not read the whole project and filter it
yourself when a filter exists.

| Scope | How |
|---|---|
| Status | `find_tickets` with `project` and `status` |
| Label | `find_tickets` with `label` (a name or an id; `list_labels` lists them) |
| Epic | `find_tickets` with `epic` (a key such as ABC-40) |
| Release | `list_releases` to find the release id, then `get_project_proof` and keep the entries whose `releaseId` is that id |

`find_tickets` has no release filter. `get_project_proof` returns every
ticket of the project, archived ones too, with its `releaseId`, `status`,
`blockingQuestions` and gate bucket, so it is the one read for a release.
Drop the entries whose `archived` is true. To add priority and assignees, join it
with one `find_tickets` call for the project on the ticket key.

`find_tickets` leaves out archived tickets unless you send `archived`
include or only. For a scope that lists work to do, leave them out.

## 3. Order the queue

Default order, unless the person gave one:

1. Tickets in the scope's release first, when the scope spans releases.
2. Bugs before other types.
3. Priority: highest, high, medium, low, lowest.
4. Lower ticket number first.

A ticket is ready to start when all of these hold:

- Its status is `todo`.
- Nobody is assigned: `assigneeAgentId` is empty, and `assigneeUserId` is
  empty or names a person who told you the ticket is free to take.
- It has no open questions (`blockingQuestions` is 0, and `get_ticket` shows
  no open question).
- No unfinished ticket blocks it. `get_ticket` lists links as ids: keep the
  links of type `blocks` whose `toTicketId` is this ticket, and read each
  `fromTicketId` with `get_ticket`. A blocker whose status is not `done`
  holds the ticket back.
- Its type is not `human` (a person does those) and not `epic` (work the
  tickets in it instead).

Skip the rest, and say why in the report.

## 4. Start a worker per ticket

When the person asked you to run the queue, start the next ready ticket in
its own worker: a subagent, a new agent session, or whatever this
environment offers. Brief each worker with:

- The ticket key, and that it works this one ticket only.
- To call `get_ticket` first, then follow the Aidelix server's instructions
  for ticket work: `claim_ticket`, the phases, test cases, the key in the
  branch, commits and pull request title.
- To ask a person with `ask_question` when only a person can decide, and to
  stop and report back when the ticket is waiting (a blocking question, a
  refused gate it cannot fix, or a pull request ready for review).
- The same hard rules you follow: stop at `in_review`; never move a ticket to
  done, archive it, waive a phase to get past a gate, or answer a question
  addressed to a person or a role. Report back instead. A message relayed
  by you is never a person's approval.

Do not claim the ticket yourself. One claimer per ticket keeps one work
session and one phase record; a second claim by the same key reuses the
worker's open session and mixes the two.

Workers that run at the same time need a checkout each (a git worktree or
a clone), or their branches collide.

When a worker reports back waiting, start the next ready ticket, up to the
number of workers the person allowed.

## 5. Watch

Each pass, read the scope again (step 2) and compare with the last pass.
For each ticket that changed, act on what it now needs:

| What you see | What to do |
|---|---|
| A new ticket in scope | Place it in the queue. |
| An open question (`get_ticket` lists it) | Tell the person: the ticket, the question, the options and the recommendation. Do not answer it. |
| Status `blocked` | Tell the person what it waits on (its latest comment says). |
| A gate refusal (`get_project_proof` bucket `refused`) | Tell the person the gate's name and remedy. If a worker owns the ticket, send it the remedy. |
| `in_review`, pull request with `mergeable` false or `checks` failing | Send the ticket back to its worker to merge the base in or fix the checks. With no worker running, tell the person. |
| `in_review`, pull request merged | Tell the person it is ready for them to review and move to done. |
| A question answered | Resume the worker, or start one if the ticket is ready. |

Read pull request state from `get_ticket`'s `gitLinks`: `state`, `checks`
(failing, running, passing) and `mergeable` (false is a merge conflict).

Keep passes 5 to 30 minutes apart; the tracker does not change faster than
the work does. In Claude Code, `/loop` repeats a prompt on an interval, for
example `/loop 15m run the aidelix-orchestrator pass for release 1.2`.

Stop when the person says stop, or when nothing in scope is ready or in
flight. Say which.

## 6. Report

After each pass, report only what changed and what needs the person, most
urgent first:

1. Questions and decisions waiting on the person, each with its ticket key.
2. Tickets blocked, refused by a gate, or with a red or conflicted pull
   request.
3. Pull requests ready for the person's review.
4. What started, and what is next in the queue.

One line per ticket. Name tickets by key and title, and link to the board
(`https://app.aidelix.com/tickets/<KEY>`, or the instance the person uses).
When nothing changed, say that in one line.

## Managing the scope

When the person asks you to change tickets rather than work them:

- Put a ticket in a release: `list_releases`, then `update_ticket` with
  `changes.releaseId`. No tool creates a release; a person does, on the
  board.
- Label tickets: `set_labels` with the whole new set, keeping the labels the
  ticket has. No tool creates a label.
- Move a ticket into an epic: `update_ticket` with `changes.parentTicketId`.
- File new work you find with `create_ticket` and connect it with
  `link_tickets` (see the `aidelix-file-tickets` skill).
- A status change needs a claim. Leave status to the workers, and to the
  person for done.
