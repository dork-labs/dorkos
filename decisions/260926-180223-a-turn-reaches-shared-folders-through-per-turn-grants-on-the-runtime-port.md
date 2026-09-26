---
id: 260926-180223
title: A turn reaches shared folders through per-turn grants on the runtime port, and room turns stand at home
status: proposed
created: 2026-09-26
spec: agent-home-desk
superseded-by: null
amends: [260807-233816]
---

# 260926-180223. A turn reaches shared folders through per-turn grants on the runtime port, and room turns stand at home

## Status

Proposed (spec `agent-home-desk`). It amends **260807-233816**, which stays `accepted`: the
"filesystem grant on the `AgentRuntime` port" that record declined on cost is now built, and the
Positive bullet "the `AgentRuntime` port is untouched" is retired. Attachments are still projected,
into the turn's working directory, which for a room turn is the agent's home again.

## Context

Once a room turn stands in the agent's home ([260926-172251](260926-172251-an-agents-identity-comes-from-its-home-and-its-desk-is-its-home-or-a-private-copy.md)),
it still has to edit its copy of the room's files and read the room's shared tree. No runtime can reach
a folder outside its working directory without asking for approval, and an approval prompt parks a
room turn. DOR-2029 (multi-repo projects) needs the same capability for sibling repos.

## Decision

We will add `additionalDirectories: { path, access: 'read' | 'write' }[]` to the per-turn runtime
options, recomputed by the dispatcher every turn. A project-room turn gets its worktree `write`, the
room's `repo/` `read`, and `repo/.git` `write` (a commit in a linked worktree writes there). Claude
Code receives them as `settings.permissions.additionalDirectories` plus deny rules for file tools on
read grants — never `--add-dir`, which loads the folder's skills; Codex as writable sandbox roots;
OpenCode as a per-session `external_directory` allow and an `edit` deny. `runtimeConformance` proves
each backend was handed exactly each turn's set.

## Consequences

### Positive

- An agent in a room can change its own repo and the room's files in the same turn.
- No room-authored skill, rule or `CLAUDE.md` reaches the agent's tool layer; `ROOM.md` stays the one
  labelled channel.
- DOR-2029 can reuse the port unchanged.

### Negative

- Read-only is advisory for anything that runs a shell, on every runtime; Codex has no per-folder
  read-only at all. The server's `MAIN_CHECKOUT_DIRTY` stop remains the real guard for `repo/`.
- Three implementations and a conformance case to maintain — the cost 260807-233816 declined.
- Agents work on files they do not stand among: `git -C` and absolute paths, taught by the context
  block and the skill.
- Skills committed to a room repo are no longer discovered (project-rooms ideation decision 13).

## Alternatives rejected

- **Claude `--add-dir` (`Options.additionalDirectories`).** Loads skills from the granted folder
  unlabelled; kept only as a fallback if the settings form fails its live gate.
- **Grant the attachment store instead of projecting.** A remote store has no local path to grant.

## Related

- `specs/agent-home-desk/02-specification.md` §4-§5.
- `260829-115623` — ROOM.md on the pinned append, the room's one instruction channel.
