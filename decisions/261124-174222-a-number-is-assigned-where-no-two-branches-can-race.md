---
id: 261124-174222
title: 'A number is assigned where no two branches can race: a timestamp, or by automation after merge'
status: proposed
created: 2026-11-24
spec: null
superseded-by: null
amends: null
---

# 261124-174222. A number is assigned where no two branches can race: a timestamp, or by automation after merge

## Status

Proposed by the architect (2026-11-24), from the review of the problems of 2026-11-23 (`research/20261124_architecture-direction-review.md` and Linear DOR-5195, DOR-5197 and DOR-4558). Becomes Accepted when the release owner and the marketplace owner agree and the operator rules on it.

**Builds on** [0312](0312-timestamp-identifiers-for-adrs-and-specs.md) and widens its rule from ADRs and specs to every shared counter. Its rule:

> "New ADRs and specs get a UTC `YYMMDD-HHMMSS` id stamped from the creating process's own clock (`.claude/scripts/id.ts`), read from no shared state, so allocation can never collide."

This record makes that one case of a rule for every shared counter. Nothing in 0312 is retired: its ids, its frozen legacy numbers and its manifest shape all stand.

**Builds on, and changes nothing in:** [260707-231641](260707-231641-changelog-fragments.md), whose rule "**Only `/system:release` writes `CHANGELOG.md`.**" is the second way this record allows: the author writes a file with its own name, and the shared result is put together at release.

## Context

On 2026-11-23 two lanes both took Flow plugin version 0.100.0, and two both took Drizzle journal index 214. A counter that an author bumps on a branch gets taken twice whenever two branches bump it at once, because each branch reads the same last value. ADR ids and specs (0312), changelog entries (260707-231641) and the DorkOS `VERSION`, which the release writes, are already free of this. Three counters were never moved:

- **Drizzle migrations.** The author picks the file's timestamp and its `idx` in `packages/db/drizzle/meta/_journal.json` (215 entries, last `idx` 214). `packages/db/src/__tests__/journal-order.test.ts` catches a clash, and an author fixes it by hand. Drizzle applies a migration only when it is newer than the last one applied, so an older stamp merged later is skipped on existing installs without a word.
- **`OPERATING_SKILLS_VERSION`** (72, in `packages/operating-skills/src/pack.ts`). The author bumps it; `version-outranks-base` in `.github/workflows/operating-skills-version-check.yml` catches a clash in the merge queue, and the author bumps again. The seeder already stamps a content hash beside the version (`packages/operating-skills/src/seed.ts`).
- **The Flow plugin's version** in the marketplace repo (0.99.2 on its main), written by hand in three manifests and a lock file, and checked by `check:bump`. Open branches had already claimed the next versions ahead of time.

## Decision

We will never let an author pick the next value of a shared counter on a branch. A value is assigned in one of two ways:

- **A timestamp id**, stamped by the author's own clock, read from no shared state (the 0312 way). Two branches cannot take the same one by accident.
- **By automation, at release or after merge**, from what has already landed (the changelog and `VERSION` way). Only one writer exists, so there is nothing to race.

Each of the three counters moves, and each has its issue:

- **Drizzle migration order:** stamped at merge time, not by the author (DOR-4558). Whether the journal itself stays a shared file is that issue's own decision.
- **`OPERATING_SKILLS_VERSION`:** goes away. Seeded skills update when their content hash changes, and never move to an older DorkOS (DOR-5195).
- **Marketplace package versions, Flow first:** each change carries a note saying patch or minor, and a workflow on the marketplace's main sets the next version (DOR-5197).

A check that only tells an author "this number is taken, bump it again by hand" is not a fix. It can stay as a net while a counter moves, never as the answer.

## Consequences

### Positive

- Parallel lanes stop colliding on numbers, and the hand-fix after a clash goes away.
- A migration can no longer be skipped on existing installs because its stamp was older than one that merged first.
- One rule covers every future counter, so a new one starts race-free instead of being found on a busy day.

### Negative

- Automation that writes after merge is one more moving part. On DorkOS it cannot push to `main`, so it lands through its own pull request or stamps inside the merge-queue build, and the release branch's cherry-pick rules (`check-picks.ts`) must accept the result. In the marketplace repo it needs write access to main.
- An author no longer knows the final number while working. A PR or a test that names its own version or migration number must stop doing so.
- Moving Drizzle's order to merge time touches how migrations are written and checked, and needs care with installs that already ran the old order.
- Marketplace authors learn a new habit: a change note instead of a version bump.

## Alternatives considered

- **Keep the counters and let CI catch collisions.** Rejected: that is today's state. The clash is caught late, in the merge queue or after, and fixed by hand each time.
- **A lock or reservation file.** Rejected: it is one shared file that two branches both edit, which is the same race in a new place.
- **Larger gaps between numbers, so lanes pick from different ranges.** Rejected: it needs coordination between lanes, which is what is missing, and it wastes the order.
