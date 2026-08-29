---
id: 260829-115625
title: Merging is the only way an agent writes a room's files, and a merge wakes nobody
status: accepted
created: 2026-08-29
spec: project-rooms
superseded-by: null
amends: null
---

# 260829-115625. Merging is the only way an agent writes a room's files, and a merge wakes nobody

## Status

Accepted. Shipped 2026-08-28 (DOR-1598, DOR-1599).

## Context

Once a room owns a repo and every agent has a worktree, work has to get back to the shared tree. Two
questions had to be settled together, because answering either one badly poisons the other.

**How does shared state get written?** Agents already have full git in their own worktrees — they can
read `main`, diff against it, and inspect any branch through the shared refs. Only writes to the shared
tree need a server. But a broad git surface would also hand agents `push --force`, `reset`, and branch
deletion, which are exactly the verbs that make a shared history unrecoverable.

**What does a merge do to everybody's attention?** Rooms have a hard-won conduct rule: over-participation
is the failure mode users complain about, and `meta/agent-etiquette.md` exists to damp it. A merge event
that triggered every member's next turn would wake N agents per merge and turn an active room into a
cascade. The notices machinery was the other candidate, and it is deliberately damped — notice codes are
rate-limited refusal-shaped events, and per-merge content must not be dropped by a damper.

## Decision

We will give agents **exactly two repo verbs** — `merge_to_room_main` (`act` tier) and
`room_repo_status` (`observe` tier), both membership-gated — and nothing else. Everything else an agent
does with a room's files is ordinary git in its own worktree. Syncing is plain `git merge main`,
deliberately not a tool.

**The merge contract is clean-only and every refusal is specific**, checked server-side before anything
moves: no repo (`NOT_A_PROJECT_ROOM`), a dirty worktree (`UNCOMMITTED_WORK`), a branch that does not
contain `main`'s tip (`BEHIND_MAIN`, answered with how far behind), nothing to merge
(`NOTHING_TO_MERGE`), a symlink pointing outside the repo (`SYMLINK_ESCAPES_REPO`), a submodule
(`SUBMODULE_NOT_ALLOWED`), and the byte caps (`FILE_TOO_LARGE`, `REPO_CAP_EXCEEDED`). Merges into one
room are serialized behind a mutex; a caller arriving while one is in flight **queues** rather than
failing, and gives up only after `rooms.repo.mergeQueueWaitMs` (`MERGE_IN_FLIGHT`). On success the server
runs `git merge --no-ff` in the integration tree under the mutex; a failure aborts cleanly, so `main` is
never left conflicted.

**Conflicts are resolved in the agent's own tree, never on `main`.** `BEHIND_MAIN` is the mechanism: the
agent syncs where it has full tools and a real working copy, and retries.

**A merge is a durable, unaddressed, system-voiced room entry** — "Ana merged `parser-fix` — 4 files,
+120/−30". It stores no mentions, addresses nobody, and triggers no turn. Agents learn that `main` moved
at their next turn, from the room context block's files section. A deliberate `@mention` by the merging
agent is the only way a merge asks for attention.

**Symlinks out of the repo are forbidden rather than resolved.** A committed symlink is a path: it
dangles on another machine, exposes one agent's private tree to every member, and bypasses commits,
provenance and the merge queue in one move. The operating skill teaches publish-on-change — copy, commit,
merge — instead. In-repo relative links are fine. This rule is part of the merge contract rather than a
record of its own, because it is only ever enforced at this one gate.

**The history is append-only.** No force-push, no reset, no branch-delete verb exists on any surface.

**The tools are named in prose by their ending, not their prefix.** The context block says "the tool
whose name ends in `merge_to_room_main`", because each runtime prefixes tool names differently and a
block that named one runtime's spelling would be wrong in the other two.

## Consequences

### Positive

- The shared tree can only ever move forward, by a whole clean merge, executed by the server. There is no
  agent-reachable way to rewrite a room's history.
- Refusals are actionable. Each one names the state and implies the remedy, so an agent recovers without
  guessing and without a person in the loop.
- Merging does not cost the room anybody's attention. A busy repo and a quiet room are compatible, which
  is the outcome `meta/agent-etiquette.md` asks for.
- Queueing rather than failing means two agents finishing at the same moment both land, in an order,
  instead of one being told to try again.
- The tool surface is small enough to reason about: two verbs, one of which only reads.

### Negative

- A slow agent can keep arriving behind `main` and re-syncing — the repeated loser. It is inherent to
  collaboration and is only bounded by merge-queue ordering and small-merge conventions.
- Every merge costs a sync first, so the cheapest possible change still involves a round trip through the
  agent's own tree.
- The room's timeline gains entries nobody asked for. A very active repo makes a noisier log, which is the
  price of merges being visible content rather than damped notices.
- Three refusal codes exist that the spec did not anticipate (`NOTHING_TO_MERGE`, `MAIN_CHECKOUT_DIRTY`,
  `MERGE_CONFLICT`), and one of them is unreachable through the ordinary path — kept only for a tree
  somebody committed into by hand.
- Forbidding symlinks means a legitimate cross-tree link has no representation, and the alternative is a
  copy that can go stale.

## Alternatives rejected

- **A broad git tool surface.** It would hand agents the verbs that make history unrecoverable, to solve a
  problem shared refs already solve for reads.
- **Resolving conflicts on `main`.** The server would be resolving in a tree the conflicting agent cannot
  see, without the tools or the context to do it well.
- **Routing merge events through the notices machinery.** Notices are damped by design; a damped
  per-merge event is a merge nobody hears about.
- **Triggering member turns on a merge.** N wake-ups per merge is the over-participation failure the room
  bounds exist to prevent.
- **Failing rather than queueing on a concurrent merge.** It converts ordinary simultaneity into an error
  the agent has to interpret.
- **Rewriting an out-of-tree symlink into a copy at merge time.** Repairing input instead of refusing it
  is the pattern that produced two provenance forgeries elsewhere in this programme.

## Related

- `specs/project-rooms/02-specification.md` §3.6, §3.7; ideation decisions 6, 7, 8, 9, 15.
- `260829-115621` — the worktrees this merges from.
- `260829-115626` — the other write path into the same tree, and its mutex.
- `260726-170127` — the room path carries its own cascade guard; why a merge entry triggering turns would
  have been the wrong kind of fuel.
- `meta/agent-etiquette.md` — the over-participation failure this damps.
