---
name: aidelix
description: Use for ticket work in a repository whose CLAUDE.md or AGENTS.md names an Aidelix project, or whenever the Aidelix tools are connected. Examples are filing a bug or a feature, reading a ticket before work starts, claiming a ticket and recording each phase of the work, moving a ticket through its statuses, recording a spec change, or checking what is open in a project. Tickets live in Aidelix, and the Aidelix MCP tools reach them.
---

# Aidelix

Tickets for this work live in Aidelix. Use the Aidelix MCP tools for all
ticket work. Do not keep tickets in local files or in another tracker.

The repository's `CLAUDE.md` or `AGENTS.md` names the project key. If it does
not, call `list_projects` and ask the human which project to use.

The Aidelix server sends its own instructions when it connects. They say how
to work a ticket. Follow them. Three habits matter most, because nothing
refuses work that skips them:

- Put the ticket key in the branch name, in every commit message and in the
  pull request title, for example `ABC-42: short summary`. Without the key,
  GitHub does not link the work to the ticket.
- After `claim_ticket`, put yourself on the ticket with `update_ticket`:
  `assigneeAgentId` is the agent id the claim returns, and an empty
  `assigneeUserId` takes its human user id.
- After you move a ticket to `in_review`, if you are still running, check
  its pull request every 5 to 10 minutes with `get_ticket`. Fix a
  merge conflict or red checks and push, until the pull request is merged
  or closed.

If the Aidelix tools are missing, or a call fails with `unauthenticated`, the
server is not connected: use the `aidelix-connect` skill.

To run many tickets at once, by release, label, epic or status, use the
`aidelix-orchestrator` skill. To write new tickets, use the
`aidelix-file-tickets` skill.
