---
id: 260711-144122
title: Runtime-agnostic operation_progress StreamEvent for long-running operations
status: accepted
created: 2026-07-11
spec: null
extractedFrom: DOR-110
superseded-by: null
---

# 260711-144122. Runtime-agnostic operation_progress StreamEvent for long-running operations

## Status

Accepted (implemented for DOR-110).

## Context

Runtimes reported the progress of long-running operations (today: context-window
compaction) in ad-hoc, runtime-shaped ways. The Claude adapter overloaded the
`system_status` StreamEvent with compaction-specific fields — `status:
'compacting'`, `compactResult`, `compactError` — and the client string-matched
its way to a treatment: `ChatStatusStrip.deriveSystemIcon()` ran
`message.includes('compact')`, and `deriveStatusCopy()` mapped the `'compacting'`
token to copy. OpenCode reported compaction only as a post-hoc
`compact_boundary`, and Codex not at all. Adding a runtime, or a second kind of
operation, meant another stringly-typed branch. This is the exact
"no stringly-typed code" and "one structured contract in the runtime interface"
problem DOR-110 was filed to fix.

## Decision

Introduce a single runtime-agnostic `operation_progress` StreamEvent (and its
`SessionEvent` fidelity member) in `@dorkos/shared`:

```ts
{ type: 'operation_progress',
  data: {
    operation: 'compaction',            // OperationKind — extensible enum
    state: 'started' | 'done' | 'failed',
    determinate: boolean,               // false → indeterminate bar
    percent?: number,                   // 0–100, only when determinate
    message?: string,                   // producer-supplied label copy
    error?: string,                     // only when state === 'failed'
  } }
```

The field invariants are enforced by a Zod `.superRefine()`, not merely
documented — an adapter that emits `percent` on an indeterminate phase, omits it
on a determinate one, or attaches `error` to a non-`failed` phase fails wire
validation. This schema is the authoritative contract future runtimes are
onboarded against, so the guarantees must hold at the boundary rather than
relying on defensive consumers.

Each runtime maps its native signal onto this shape and degrades honestly:

- **claude-code** maps `status: 'compacting'` → `started` (indeterminate — the
  SDK exposes no percent, matching the CLI's own indeterminate bar); the
  resolving status's `compact_result`/`compact_error` → `done`/`failed`.
- **opencode** sees only a post-hoc `session.compacted`, so it emits a lone
  `done` (no start, no percent) alongside the durable `compact_boundary` row.
- **codex** has no compaction concept and emits nothing.

The compaction-specific fields (`compactResult`, `compactError`) are removed from
`SystemStatusEventSchema`, which reverts to a generic informational channel
(hook flashes, raw status tokens). The `compact_boundary` event stays as the
durable transcript row; `operation_progress` drives the transient status-strip
treatment and, on `failed` (no boundary fires), the inline failed-compaction row.

The client consumes the structured shape with no string matching:
`deriveSystemIcon`/`deriveStatusCopy` are deleted, the strip gains an
`operation-progress` rung that renders an indeterminate/percent bar, and a
per-session `operationProgress` store field is derived from the projected turn.

Every runtime is held to the contract by the shared conformance suite: a generic
invariant check validates any emitted `operation_progress` (percent only when
determinate), and an optional `makeCompactingRuntime` factory asserts the full
started→resolved lifecycle for runtimes that can script a compaction (claude-code,
opencode).

## Consequences

- One structured, extensible contract replaces three per-runtime progress paths;
  a new operation (indexing, model download, …) adds an `OperationKind` member and
  every consumer keeps working (unknown kinds degrade to the generic bar).
- `system_status` is honestly scoped to generic informational status again.
- The event schemas are OpenAPI-surfaced, so `docs/api/openapi.json` regenerates.
- Persisted session-event rows carrying the old `system_status` compaction fields
  (pre-launch alpha, ephemeral) are simply dropped by Zod on read — no migration.
