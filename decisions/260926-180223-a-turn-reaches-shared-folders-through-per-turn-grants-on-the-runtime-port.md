---
id: 260926-180223
title: A turn reaches shared folders through per-turn grants on the runtime port, and room turns stand at home
status: accepted
created: 2026-09-26
spec: agent-home-desk
superseded-by: null
amends: [260807-233816]
---

# 260926-180223. A turn reaches shared folders through per-turn grants on the runtime port, and room turns stand at home

## Status

Accepted (spec `agent-home-desk`; designed in #2153). Shipped: per-turn directory grants on all
three runtimes, gated by `runtimeConformance`, in #2162 and #2170 (DOR-2408); room turns standing
at home with the narrowed `.git` grant and the `ROOM_REPO_CONFIG_UNSAFE` audit in #2197 (DOR-2410);
an agent attaching a file from its own copy of the room's files, as well as from its home, in #2221.
Residual limits, recorded rather than solved: the `repo/.git/objects/` and `refs/heads/room/` (with
its reflog folder) grants are shared by every agent in the room, so an agent can overwrite a loose
object or move another agent's `room/<slug>` branch (see Negative). Closing them needs a per-agent
object store and per-agent refs, which is follow-up work.

It amends **260807-233816**, which stays `accepted`: the
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
room's `repo/` `read`, and `write` on exactly the parts of `repo/.git` a commit and a `git merge main`
in a linked worktree write: `objects/`, `refs/heads/room/`, `logs/refs/heads/room/` and its own
`worktrees/<slug>/` (amended in T4, DOR-2410). Never all of `repo/.git`: that would hand every agent
the room's shared `hooks/`, `config` and `info/`, which run for the other agents' commits and can
name programs git executes. The server's own git in a worktree is pinned to the room's storage
(`GIT_DIR`, `GIT_COMMON_DIR`, `GIT_WORK_TREE` from the layout), so a rewritten `.git` pointer or
`commondir` in an agent-writable folder cannot hand it a config an agent wrote. Claude
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
- The narrowed `.git` grant is enforced for file tools and sandboxed shells only. A shell that is not
  sandboxed (Claude Code's Bash under `bypassPermissions`) can still write the room's shared git
  storage, as it can any folder; agents' own sessions keep a person's hooks on purpose
  (`SESSION_GIT_CONFIG`), so such a write can run in another agent's commit. That is the same
  exposure as that shell writing anywhere else, and is stated, not solved, here. Such a shell can
  also write `repo/.git/config` (a plain `git config` in a copy lands there); the server audits that
  config before every git command in the room and refuses (`ROOM_REPO_CONFIG_UNSAFE`) rather than
  run any filter, driver, include, fsmonitor or credential helper it defines.
- The `objects/` and `refs/heads/room/` grants are shared folders. An agent can overwrite a loose
  object (git does not re-hash on read, so `main`'s content can change without a commit) and can
  move or erase another agent's `room/<slug>` branch and reflog. No code runs; closing both needs a
  per-agent object store and per-agent refs (follow-up).
- The server's git in a room never recurses into submodules (`diff.ignoreSubmodules=all`): a
  submodule an agent commits carries its own git config, whose filter program a status read would
  otherwise run as the server.
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
