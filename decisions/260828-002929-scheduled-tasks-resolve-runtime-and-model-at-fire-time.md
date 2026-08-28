---
id: 260828-002929
title: Scheduled tasks resolve runtime and model per task at fire time, through the shared defaults ladder
status: accepted
created: 2026-08-28
spec: task-runtime-model
superseded-by: null
---

# Scheduled tasks resolve runtime and model per task at fire time

## Status

Accepted

## Context

The scheduler's runtime was a single object captured at server boot
(`schedulerAgentManager` = the claude-code runtime), never the registry, and the
`SchedulerAgentManager` port stripped `model`/`effort` from the options it
forwarded — so every scheduled run ignored the target agent's declared runtime,
its manifest model, and `runtimes.*.defaultModel` (DOR-1347). Two constants
(`scheduled-run-power.ts`, `TaskFormInner.tsx`) hardcoded `'claude-code'` with
comments predicting exactly this change. Meanwhile interactive sessions, rooms
(DMs included) and relay agent turns already resolve runtime per agent and
model through `resolveUnattendedSessionDefaults`.

Alternatives considered: (a) keep tasks claude-code-only and add only a model
field; (b) reuse the SKILL.md top-level Claude-Code-dialect `model:` frontmatter
as the task's model; (c) validate model ids against the runtime catalog at
write time.

## Decision

A scheduled task may declare `runtime`, `model`, and `effort` inside its
`schedule:` block. At fire time the scheduler resolves execution per task,
first hit wins:

- runtime: `schedule.runtime` → agent manifest `runtime` (if registered) →
  registry default.
- model/effort: `schedule.*` → skill top-level `model:`/`effort:` (only when
  the resolved runtime is claude-code) → agent manifest (model only on runtime
  match) → `runtimes.<section>.default*` → runtime default — the same
  `resolveUnattendedSessionDefaults` ladder rooms and relay use, not a parallel
  one.

The scheduler binds to the runtime registry, not one boot-time runtime. Model
strings live in the resolved runtime's id space and are deliberately
unvalidated at write (agent-manifest policy): accepted, warned about in UI,
error at run time. A sticky task whose resolved runtime changed starts a fresh
session (sessions are runtime-bound first-write-wins, ADR-0255). A resolved
runtime that is unregistered at fire time fails the run loudly — never a
silent fallback. In v1, only claude-code tasks ride the relay dispatch path;
other runtimes dispatch direct until relay carries per-runtime adapters
(DOR-1614, ADR-0257's follow-through).

## Consequences

### Positive

- Scheduled tasks join every other surface on one resolution ladder; "unset
  means the agent's default" holds product-wide.
- The run record stamps the resolved runtime/model, so history reports what
  actually ran even as defaults drift.
- The two hardcoded `TASK_RUNTIME` constants and their documented debt retire.

### Negative

- Fire-time resolution means a task's behavior can change when an agent
  manifest or server default changes between fires — by design, but it makes
  "why did this run on X?" a ladder question; the stamped run record is the
  answer surface.
- Loud failure on a disabled runtime trades resilience for honesty: a task tied
  to a gated runtime stops running rather than degrading to claude-code.
