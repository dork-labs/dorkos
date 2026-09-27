---
id: 260926-172251
title: An agent's identity comes from its home, and its desk is its home or a private copy of it
status: accepted
created: 2026-09-26
spec: agent-home-desk
superseded-by: null
amends: [260726-022251, 260829-115621]
---

# 260926-172251. An agent's identity comes from its home, and its desk is its home or a private copy of it

## Status

Accepted (spec `agent-home-desk`, DOR-2355; shipped by DOR-2410, #2197). It amends two accepted records, which stay `accepted`:

- **260726-022251** — "identity comes from the session's working directory" is narrowed. The working
  directory stays the lookup key, but it is resolved to a registered home before anything is read.
- **260829-115621** — retires the reading of "Only that agent's turns run in it" under which a room
  worktree is a turn's working directory (the DOR-1597 rung). The worktree stays the agent's one
  private write place in the room; how a turn reaches it is
  [260926-180223](260926-180223-a-turn-reaches-shared-folders-through-per-turn-grants-on-the-runtime-port.md).

## Context

DorkOS reads an agent's persona, `NOPE.md`, memory, tool groups and account pin straight from
`<cwd>/.dork/`. That is right only while the working directory is the agent's home, and room
worktrees, git worktrees of a repo agent's home (which carry a committed, possibly stale `.dork/`), and
managed checkouts all break it (DOR-2355). The working directory cannot simply be pinned to the home:
git, pnpm, hooks and `CLAUDE.md` act on it, so an agent coding in its own worktree must stand there.

## Decision

We will read identity-bearing config only from the agent's registered **home**; a committed `.dork/`
anywhere else is just a file. A turn's **desk** (working directory) is the home, a private copy of the
agent's own home repo (a git linked worktree with git's backlink intact, or a managed workspace the
agent owns), or — only for an agent configured `workspace.mode: 'none'` — the operator's
`DEFAULT_CWD`. A turn dispatched as a named agent is refused `DESK_NOT_OWN` if its desk is another
agent's home or a copy of it, or any room folder (DOR-2356).

## Consequences

### Positive

- A worktree's stale `.dork/` can never change who an agent is, what it remembers, or which Claude
  account pays.
- One resolver answers "whose folder is this" for every runtime, and a branded `AgentHome` type makes
  reading identity from a raw working directory a type error.
- Room turns and direct sessions with an agent group under one transcript folder again.

### Negative

- Resolving a linked worktree costs a few small file reads per session launch.
- A misconfigured relay or task binding that used to run unattributed is now refused loudly.
- An agent's home can now host several concurrent turns (rooms and direct sessions); two turns editing
  one checkout is the DOR-500 interleaving, bounded only by a skill rule and the per-agent cap.

## Alternatives rejected

- **The desk never changes.** Breaks every coding tool that keys on the working directory.
- **Keep reading `<cwd>/.dork/` and exclude `.dork/` from worktrees.** `info/exclude` cannot hide a
  tracked file, and a hidden untracked `.dork/` would hide a person's work from the reap.

## Related

- `specs/agent-home-desk/02-specification.md` §2-§3.
- `260801-003050` — a duplicate manifest never registers, which already kept worktree copies out of
  the registry.
- `260926-180223` — grants on the runtime port; `260926-172252` — people's file operations and the
  turn-start refresh.
