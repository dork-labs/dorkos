---
id: 260924-213416
title: A schedule's name, runtime, model, effort, time limit and memory are part of what a person approves
status: draft
created: 2026-09-24
spec: null
superseded-by: null
---

# 260924-213416. A schedule's name, runtime, model, effort, time limit and memory are part of what a person approves

## Status

Draft (DOR-2323). Extends `260924-101531` (the timezone joined the key in DOR-2307).

## Context

A person's approval of a schedule is a stored content key. It was `[prompt, cron, timezone]`, so an agent could change an approved schedule's name, runtime, model, effort, time limit (`maxRuntime`) or session memory (`sticky`) and it kept running. DOR-2313 parks an agent's change to approved work in the same request, but only for what the key covers.

## Decision

The key is `[prompt, cron, timezone, name, runtime, model, effort, maxRuntime, sticky]` (`scheduleContentKey`, `ScheduleSettings`).

- **name, runtime, model, effort** (operator decision): each changes what an unattended run does or costs. The name is what the run is told (`Job: <name>`); the runtime, model and effort decide which agent does it, how capable it is, and what it spends.
- **maxRuntime** (judgment): included. It is the ceiling on how long, and so how much, one unattended run may spend; an agent raising it from 10 minutes to 8 hours changes the cost and blast radius the person agreed to. Lowering it is also a change, and is asked about too: an asymmetric key would be a second rule for one field, and agents rarely touch it.
- **sticky** (judgment): included. It decides whether every run resumes one session and carries everything earlier runs saw, which changes what a run knows and can repeat, not only how it is bookkept.
- **Not included:** `enabled` (the person's own switch), `permissionMode` (its own grant rule), `description` and `displayName` (nothing a run reads).
- **The key holds the schedule's own values, not resolved ones.** A null runtime, model or effort means "follow the agent", and the key records that null. Changing the agent's own defaults (its `.dork/agent.json`, which an agent can edit because it is its working directory) or the server's default therefore changes what such a schedule runs without touching its approval. That gap is deliberate here and closed elsewhere: resolved values in the key would park every schedule that follows an agent whenever a person edits that agent's defaults. DOR-2328 gates an agent’s write to an agent's runtime, model or effort defaults behind a person's approval instead, the same pattern as schedules.

An agent's change to any of them parks the schedule in the same request with `AGENT_SETTINGS_CHANGE_REASON` (the prompt and timing sentences keep priority in that order: prompt, settings, timing). A person's change re-approves, as before.

The approval a park withdraws is kept in `previous_approval_key` (migration `0110`), never read by a gate, and cleared when an approval is recorded. The API derives `approvalChanges` from it for a waiting schedule, and the approval card lists old → new.

**Upgrade.** `upgradeLegacyApprovalKeys` runs at boot before any watcher, as in DOR-2307: a two- or three-part key is extended with the timezone and settings the row runs with now, the only values it was ever checked against. Nothing is parked by the upgrade and nothing is newly approved; a stale grant stays unmatched.

## Consequences

### Positive

- An agent cannot move an approved schedule to another runtime or a costlier model, or let it run longer, without a person seeing it.
- The card says what changed, so re-approving is a decision about the change.

### Negative

- Hand-editing any of these fields in a SKILL.md parks the schedule at the next sync, like a prompt edit.
- A schedule that follows its agent's runtime, model or effort is still moved by a change to the agent's defaults. DOR-2328 gates that write when an agent makes it through any DorkOS door (`operator.update_agent_execution`, whose card shows old → new); a hand edit of `.dork/agent.json` and the server-wide runtime defaults are not gated by it.
- A downgrade to a build before this reads a nine-part key as unmatched and parks approved schedules once.
