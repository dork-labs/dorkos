---
id: 260926-172251
title: An agent's identity comes from its home; its desk is its home or a private copy of it; shared folders are granted
status: proposed
created: 2026-09-26
spec: agent-home-desk
superseded-by: null
amends: [260829-115621, 260807-233816, 260726-022251]
---

# 260926-172251. An agent's identity comes from its home; its desk is its home or a private copy of it; shared folders are granted

## Status

Proposed (spec `agent-home-desk`, DOR-2355). It amends three accepted records, each of which stays
`accepted`:

- **260829-115621** — retires one clause: "Only that agent's turns run in it" read as _the turn's
  working directory is the worktree_ (together with `specs/project-rooms` ideation decisions 5 and
  13 and spec §3.5 rung 2). The worktree stays the agent's one private write place in the room; the
  turn no longer stands in it. The layout, the one-writer rule, lazy creation, the four-gate reap and
  "no `Workspace` reuse" all still govern.
- **260807-233816** — its rejected alternative, "a filesystem grant on the `AgentRuntime` port", is
  now built, for room files. Attachments are still projected, and the projection root returns to the
  agent's home because that is the turn's working directory again; the 2026-08-30 note's
  "cwd is the worktree" stops being true.
- **260726-022251** — "identity comes from the session's working directory" is narrowed: the working
  directory is the _lookup key_, resolved to a registered home before anything identity-bearing is
  read. Nothing identity-bearing is ever read from the working directory itself.

## Context

DorkOS keys agent identity on the turn's working directory in two different ways. Who a turn acts as
comes from an identity anchor, but its persona, `NOPE.md`, memory, tool groups and account pin are
read straight from `<cwd>/.dork/` (`launch-resolver.ts`, `agent-context.ts`, the codex and opencode
context builders). That is correct only while the working directory IS the agent's home, and three
live paths break it: project-room turns run in a room worktree (DOR-1597), a git worktree of a repo
agent's home carries a committed, possibly stale copy of `.dork/` (about 20 of 35 agents live at a
repo root), and `managed` workspace turns run in a checkout. DOR-2355 is the visible failure, and
DOR-1640 (seeding the skill pack into every room worktree), the `extraDirs` transcript fan-out and the
`WorkingCopyOwnerPort` are patches around the same root cause. The fix "the working directory never
changes" is not available: coding tools (git, pnpm, lefthook, `CLAUDE.md`, `.claude/settings.json`,
per-worktree ports) act on the working directory, so an agent coding in its own worktree must stand
in it.

## Decision

We will separate three things an agent has, and hold each to one rule.

- **Home** is the registered folder holding `.dork/agent.json`. It is the **only** place DorkOS reads
  identity-bearing config from: `agent.json`, `SOUL.md`, `NOPE.md`, memory, tool groups, the account
  pin, the operating skills pack. A committed `.dork/` anywhere else — in a worktree of the home repo,
  in a room repo, in a managed checkout — is just a file.
- **Desk** is the turn's working directory. It is the home, or a private copy of the agent's own home
  repo: a git linked worktree whose relative position matches the home's (the gtr and subagent
  worktree case, future worksessions DOR-2161), or a `managed` workspace whose recorded owner is this
  agent (DOR-84). A desk is never a room's folder and never another agent's home. Every turn
  dispatched **as a named agent** (room, relay binding, task) is checked against this rule before the
  runtime is called, and refused if it fails (DOR-2356).
- **Shared folders** are places a turn may reach without standing in them. They are granted per turn
  through a new `AgentRuntime` option, `additionalDirectories: { path, access: 'read' | 'write' }[]`,
  shaped so DOR-2029 (multi-repo projects) can reuse it.

A project-room turn therefore runs with desk = home, its room worktree granted `write`, the room's
integration tree `repo/` granted `read`, and the repo's shared git directory granted `write` so a
commit in the worktree can land. The room context block names the exact absolute paths and commands.

**Per-runtime mechanics, with their honest limits:**

| Runtime     | `write` grant                                                           | `read` grant                                                                                  | What is not enforced                                                                                                         |
| ----------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| claude-code | `settings.permissions.additionalDirectories` (loads no skills or rules) | the same, plus `settings.permissions.deny` for `Edit`/`Write`/`NotebookEdit` on `//<path>/**` | Bash can still write anywhere its mode allows. `CLAUDE.md` from a granted folder never loads; DorkOS never sets the env var. |
| codex       | `ThreadOptions.additionalDirectories` (writable sandbox roots)          | nothing to hand: the sandbox already reads outside the workspace                              | A read grant is not a restriction; under `danger-full-access` nothing is.                                                    |
| opencode    | per-session `external_directory` rule `allow` on `<path>/**`            | the same, plus an `edit` rule `deny` on `<path>/**`                                           | Shell commands can still write.                                                                                              |

`repo/` stays protected server-side exactly as before: an out-of-band write makes it dirty, and
`MAIN_CHECKOUT_DIRTY` stops every write path loudly (ADR 260829-115626). `runtimeConformance` gains a
case proving each backend was **handed** each grant, in the shape it enforces, or a declared reason
why it cannot be proven.

Committed `.dork/` in a room repo is not excluded through `info/exclude`: that file cannot hide a
tracked path, and hiding an untracked `.dork/` would hide a person's work from the reap's dirty check.
It needs no exclusion, because nothing reads it.

## Consequences

### Positive

- One rule answers "who is this agent?" everywhere, so a worktree's stale `.dork/` can never change a
  persona, a memory, a tool group or which Claude account pays.
- A room about DorkOS can ask the `dorkos` agent to fix real `dorkos` code: its desk is its repo, and
  the room's files are a granted folder beside it.
- A room turn and a direct session with the same agent group under the same transcript folder again,
  as `specs/rooms` §14.4 describes.
- Four patches become dead code and are removed: worktree skill-pack seeding and projection (DOR-1640),
  the owner port's room-worktree branch, `extraDirs` fed by the live worktree list, and the room
  worktree rung in `resolve-session-cwd.ts`.
- The port can carry DOR-2029's multi-repo grants without another design round.

### Negative

- Read-only is advisory on every runtime for anything that runs a shell. The server-side dirty check
  on `repo/` is the real guard, as it is today.
- The grant costs three implementations and a conformance case — the price ADR 260807-233816 declined.
  Codex has no read-only per folder at all.
- Agents must work in a folder they do not stand in: `git -C <worktree>` or `cd` first, and absolute
  paths for edits. The context block and the `working-in-room-repos` skill carry this, but an agent can
  still write into its home by mistake.
- Skills committed to a room repo are no longer discovered by any harness (ideation decision 13's
  "native" consumption is retired). `ROOM.md` is the room's instruction channel; a room that wants
  more can point at the files from it.
- Existing room transcripts were filed under worktree folders and must be migrated or kept findable.
- Resolving a linked worktree to its home costs a small filesystem read per session launch.

## Alternatives rejected

- **The desk never changes.** Breaks every coding tool that keys on the working directory.
- **Keep cwd = room worktree and read identity from the anchor.** Fixes identity but keeps every other
  patch, and a room turn still cannot touch the agent's own repo.
- **Grant through Claude's `--add-dir` (`Options.additionalDirectories`).** It loads skills from the
  granted folder, which would let a room's members put instructions into the agent's tool layer
  unlabelled. It stays the fallback if the settings form does not grant access under the SDK.
- **Grant the attachment store instead of projecting.** A remote attachment store has no local path
  to grant, so projection stays.

## Related

- `specs/agent-home-desk/02-specification.md` — invariants, seams, tasks.
- `260829-115621`, `260807-233816`, `260726-022251` — amended here.
- `260801-003050` — a duplicate manifest never registers, which is why worktree copies were already
  kept out of the registry.
- `260926-172252` — the companion record for people's file edits and turn-start refresh.
