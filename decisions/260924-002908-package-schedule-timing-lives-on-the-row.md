---
id: 260924-002908
title: A person's timing for a package's schedule lives on the row
status: draft
created: 2026-09-24
spec: package-schedule-timing
superseded-by: null
---

# 260924-002908. A person's timing for a package's schedule lives on the row

## Status

Draft (extracted from spec: package-schedule-timing)

## Context

A schedule that ships inside an installed package lives in the package's own SKILL.md, which DorkOS never writes: the edit would be shared by every agent that installed the package and wiped by the next update. FB-26 already moved one decision onto the row for that reason, the on/off switch. Timing was still the file's alone, so a person could not change when a package's schedule runs without forking the package. The arm gate and the bypass keep-grant both compare a content key of `[prompt, cron]` (ADR `260823-200726`), so whatever holds the timing has to be the cron those gates read.

## Decision

A package-owned schedule's cron and timezone can be overridden on its row (`pulse_schedules.cron_override`, `timezone_override`, NULL meaning "the file's"). The file's values stay in `cron`/`timezone` as the default, and the sync keeps writing them. Every reader uses the effective value (override, else default): the row mapper resolves it once for every Task consumer, and the four raw-row readers — the grant writer, the grant back-fill, the migration re-key and the file-sync gates — share one helper. The approval key is unchanged in shape and its cron is the effective one. A person's change re-keys the grant in the same act; an agent's change parks an active schedule in the same request, because a row-only write wakes no watcher and the new timing would otherwise run unapproved until the next sweep. `resetTiming: true` clears both overrides. A timing written to a file DorkOS can write still goes to the file and clears any override of it.

## Consequences

### Positive

- A person can change when a package's schedule runs without touching the package, and the change survives syncs and package updates.
- A package update that changes only its default cron does not disturb an overridden schedule; a changed prompt still parks it.
- No reader needed its own fix: the mapper and one helper cover them all.

### Negative

- Two sources of timing on one row; anything that reads the raw columns must go through the helper or it reads the package's timing instead of the one that runs.
- The approval an agent's timing change needs is enforced at the write, not by the sync, so a third update door would have to call the same settle step.
