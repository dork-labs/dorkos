# Agent memory — implementation record

Closed 2026-08-25. Every phase in `03-tasks.json` shipped; the spec is implemented.

## What shipped, by phase

| Phase                   | PR    | What landed                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0 + P1 (core)          | #1290 | `@dorkos/memory` package; the `memory_write` capability; per-agent `MEMORY.md` injected each turn via `buildMemoryBlock` (`apps/server/src/services/runtimes/shared/agent-context.ts`); evals X-09 / X-11b / X-12 (`packages/evals/src/suite/memory.ts`). Umbrella DOR-632.                                              |
| P2 (member-room recall) | #1306 | `list_member_rooms` + `search_member_rooms` tools; evals X-10 / X-13. DOR-1532.                                                                                                                                                                                                                                          |
| P3 (provider seam)      | #1309 | `MemoryProvider` becomes the codebase's fifth swappable seam: registry in `apps/server/src/services/memory/registry.ts`, conformance suite in `packages/test-utils/src/memory-conformance.ts`, `memory.provider` config with the 0.69.0 migration, authoring guide `contributing/adding-a-memory-provider.md`. DOR-1533. |

## Hardening that followed the live VERIFY runs

All five eval cases ran against a real model on 2026-08-25 (run dirs recorded in `packages/evals/README.md`, which now names the model per row; the runner records `model` into `results.json` going forward).

- **DOR-1564 (PR #1318)** — X-09 failed 3/3 on Sonnet: the agent acknowledged a fact told in a direct chat and never called `memory_write`. One rule added to `buildSessionModelBlock`: only the operator, one-to-one, sets standing preferences, and the turn is not finished until the save has actually run (or the reply says it was not kept). 5/5 oracles green on the final prose; Haiku full-suite no-regression with X-11b passing exercised.
- **DOR-1560 (PR #1323)** — a benched (faulted) backend was invisible: now `GET /api/system/memory`, a standing app banner (covering the benched _and_ the configured-but-unregistered cases), and an in-band note when the memory block renders. The first-bench-with-absent-file case deliberately stays silent; the registry docblock records that open question.

## Deliberate design points worth keeping

- Refusal (typed port errors) ≠ fault; a read-refusal answers an `'error'` snapshot in place and never falls back to builtin (wrong-memory > no-memory; rationale in the registry docblock).
- The bench is process-lifetime with one warning; builtin is a _different store_, not a copy of the faulted backend's notes — agent-facing copy says so.
- Channel-stamped notes never count as operator preferences (the X-11b stamp-over-prose rule), and the save-discipline rule is scoped so it cannot be weaponized from a room.

## Evidence pointers

Eval run directories under `packages/evals/.evals-runs/` (2026-08-25): `19-13-17-775Z` (Sonnet baseline, X-09 red), `21-01-41`/`21-02-15`/`21-31-17` (X-09 Sonnet green), `21-02-47` (Haiku full suite), `21-29-37`/`21-30-41` (X-11b Sonnet, not exercised — reported as neutral). Tracker: DOR-632, DOR-1532, DOR-1533, DOR-1564, DOR-1560.
