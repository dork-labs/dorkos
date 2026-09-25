---
id: 260925-041616
title: New workspaces are shown before anything runs there, and their hooks run only as shown
status: accepted
created: 2026-09-25
spec: null
superseded-by: null
---

# 260925-041616. New workspaces are shown before anything runs there, and their hooks run only as shown

## Status

Accepted (DOR-2335)

## Context

A workspace is a folder sessions run in. `provider: 'clone'` cloned any repository into one, and its `.claude/settings.json` hooks and allow rules, `.mcp.json` and skills then loaded in every session there. Any caller could ask for one: `POST /api/workspaces`, a session turn's `workspaceKey`, or an agent's managed checkout, whose binding lives in an `agent.json` the agent can rewrite. The source's `.dork/workspace.json` also ran `after_create` and `before_remove` as shell from the server, with no permission prompt, and `before_remove` was read again from the source at removal time.

## Decision

- **`WorkspaceService.ensure` requires a gate** to make a new workspace, and refuses without one. Reusing a ready workspace needs none.
- **A clone is staged under `<root>/.staging/` and read there** before anything is recorded or run: the same agent-workspace readers the template gate uses (harness configuration, each settings file written out, what its skills run), plus every link and the source's hooks. The staged clone, not a second fetch, is what lands.
- **Who decides:**
  - A person is shown a workspace that brings anything, as a 409 `workspace_needs_review` whose body writes everything out. They make it with the review hash they saw.
  - Anyone else gets a `workspaces.create` card, bound to the source, the provider, the folder, the cloned bytes, the links and the hooks. It is raised for every clone, since a fetched repository shapes every session there, and for a worktree whose source runs hooks.
  - Callers that cannot carry a token remember one pending card per workspace. These are the session turn and the managed checkout.
- **Hooks run only as shown.** `after_create` runs the commands that were inspected, never a second read. The `before_remove` commands that were shown are recorded on the workspace manifest (`removeHooks`), and removal runs only those. For a workspace made before this record existed, a person is shown its source's `before_remove` commands and may run exactly those; anyone else removes it without them, and is told which were skipped.
- **A person's own worktree hooks are remembered**, in the operator-only hook decision list, keyed by the source's real path, the provider and a digest of both hook lists: unchanged hooks pass, a changed command asks again, and `dorkos harness hooks --revoke <folder>` forgets it. Never a clone, never an agent.
- **The card's tier follows what the workspace brings:** `act` for one that brings nothing, `destructive` for one with settings, links, skill effects or hooks.
- **A remembered card survives a restart**: the next turn reopens the open card of exactly the same request (the approval service rotates a fresh token onto it) instead of raising a second one.

## Consequences

### Positive

- No path makes a workspace whose settings, links, skill commands or hooks run without someone seeing them.
- A card or review approves exactly the tree and commands shown: a repository or `workspace.json` that changes afterwards is asked about again.

### Negative

- A person's own worktree whose source runs hooks needs one review per hook set; a session turn with such a key runs in its original folder until the workspace is made over HTTP.
- An agent's first turn with a new managed checkout runs in its own folder until a person approves the card.
- `before_remove` hooks of workspaces made earlier run only when a person allows them at removal.
- Editing a workspace's manifest on disk is out of scope, as with the content hash's threat boundary: a local process that can write it can already run anything.
