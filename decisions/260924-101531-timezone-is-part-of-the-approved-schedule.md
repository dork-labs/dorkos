---
id: 260924-101531
title: A schedule's timezone is part of what a person approves
status: accepted
created: 2026-09-24
spec: null
superseded-by: null
amends: 260823-200726
---

# 260924-101531. A schedule's timezone is part of what a person approves

## Status

Accepted (DOR-2307).

## Context

A schedule's arm grant and its bypass keep-grant share one content key (ADR `260823-200726`). The key was `[prompt, cron]`, so a change of timezone was not a change of approved work. An agent could move an approved schedule to another timezone, which shifts its real run time by up to a day and can cross a day boundary, and it stayed approved. The DOR-2302 review showed this: an agent set `Pacific/Kiritimati` and the schedule stayed active.

## Decision

The key is `[prompt, cron, timezone]`, with cron and timezone meaning the ones that run (a person's override on a package's schedule, else the file's). A timezone change therefore does what a cron change does. An agent's change re-parks the schedule and drops a full-power grant. A person's change in DorkOS re-approves it in the same act. A file edit that moves the timezone parks at the next sync.

Approvals recorded under the old key are moved over once, at boot, before any watcher starts (`TaskStore.upgradeLegacyApprovalKeys`). Each two-part key is extended with the timezone the row runs in now. That is the only timezone the old grant was ever checked against, because no timezone change ever withdrew it. So the move keeps running exactly what was running approved, approves nothing new, and leaves a stale grant exactly as stale. It is computed in JS rather than SQL for the reason the grant back-fill gives: SQLite's JSON writer is not guaranteed to escape the way `JSON.stringify` does, and a one-byte difference is a grant that never matches.

## Consequences

### Positive

- An agent can no longer move when an approved schedule really runs without a person seeing it.
- No approved schedule is parked by the upgrade, and none gains an approval it did not have.

### Negative

- Editing only the timezone in a schedule's file by hand now parks it for approval, as editing its cron always has.
- Going back to an older build parks every approved schedule: that build computes the two-part key, and no stored key matches it any more.
- The timezone is compared as written, so a change between two spellings of the same zone (an alias, or a difference in case) parks the schedule even though its run times do not move. That errs toward asking a person, and is left as it is.
- If an agent changed a schedule's timezone before this shipped, the upgrade carries the approval over to that timezone. The old key never recorded which timezone was approved, so there is no way to tell.
