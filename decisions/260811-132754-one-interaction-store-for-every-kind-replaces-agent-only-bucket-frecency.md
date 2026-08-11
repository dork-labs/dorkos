---
id: 260811-132754
title: One interaction store for every kind replaces agent-only bucket frecency
status: accepted
created: 2026-08-11
spec: sidebar-now-today-library
supersedes: 67
superseded-by: null
---

# One interaction store for every kind replaces agent-only bucket frecency

## Status

Accepted. Supersedes [ADR-0067](0067-slack-bucket-frecency-for-agent-ranking.md).

## Context

ADR-0067 adopted Slack's 6-bucket frecency for ranking **agents** in ⌘K's
"Recent Agents" list, in a localStorage key of the palette's own
(`dorkos:agent-frecency-v2`), and deliberately abandoned the key before it
rather than migrating.

Three things have changed since.

- **The list it ranked is gone.** ⌘K's untyped state is now a command center
  (Continue / Recent / New) and a typed query is one ranked list across every
  kind of thing (spec `sidebar-now-today-library` §15). There is no "Recent
  Agents" group left for a bucket score to order.
- **A second store arrived beside it.** The sidebar's Today zone orders by the
  operator's own attention (BC-16), which needs a fact no server has, so
  `entities/interactions` was created to hold it — keyed `<kind>:<id>` for
  conversations, rooms and agents alike. Two client stores then knew
  overlapping halves of one fact: one knew WHEN you opened anything, the other
  knew HOW OFTEN you opened an agent.
- **The asymmetry was visible in the product.** Only agents could reach a full
  frecency score, so however much you used a channel, it ranked below an agent
  you opened the same amount.

## Decision

**One store, `entities/interactions`, holds both halves for every kind**, and
the palette keeps no memory of its own. `dorkos:agent-frecency-v2` is folded
into it and deleted from the browser.

Three parts of ADR-0067 are reversed:

1. **The bucket algorithm is replaced by continuous decay.** Ranking is
   `palette-ranking`'s blend of relevance × frecency × recency, where the
   frecency term averages a half-life decay on "how recently" with a saturating
   curve on "how often". Same trade as Slack's buckets, without the cliff
   between them, and it is one term in a blend rather than the whole score.
2. **Data is migrated, not abandoned.** ADR-0067's "start fresh" was defensible
   for a key nobody had used for long; it is not defensible for a year of a
   person's own history, and the spec makes it an acceptance criterion (P3
   AC-4). Translation needs the agent roster, because the retired key stored
   mesh ids where this store stores directories, so it runs as a hook that waits
   for the roster (`legacy-frecency-migration.ts`).
3. **Merging takes the larger of each field, never the sum.** Two tabs racing on
   the same payload — one having read it before the other deleted the key — then
   converge on the same records instead of double-counting.

**Actions and slash commands are deliberately not recorded**, which is the one
place a wider store would have been the obvious move. The sidebar's
"While you were away…" digest dissolves when the newest record moves, of
whatever kind, so recording an action would mean toggling the theme from ⌘K puts
away a summary of the night's work. The rule the store keeps is therefore _a
record is a place you went, not a thing you did_.

## Consequences

### Positive

- Every kind ranks on the same two facts; a channel you live in can now outrank
  an agent you rarely open.
- One store, one localStorage key, one place to reason about growth — records are
  capped and both maps are pruned on one key set, so a count can never outlive
  the timestamp it belongs to.
- The sidebar and ⌘K read the same memory, so opening a conversation from either
  door builds the same history.

### Negative

- A person who had used ⌘K heavily for agents and never opened a channel will
  see agents keep their lead for a while, because only agents arrive with a
  count from the old key.
- The migration module is code that exists only to be deleted, and it cannot be
  deleted until no browser plausibly still holds the retired key.
- Ranking is now a blend with four free parameters instead of six named buckets.
  The numbers are documented where they live, but they are tuned rather than
  borrowed from a system running at Slack's scale.
