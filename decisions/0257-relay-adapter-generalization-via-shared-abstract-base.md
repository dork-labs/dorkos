---
number: 257
title: Relay Internal Adapter Generalization via Shared Abstract Base
status: proposed
created: 2026-04-16
spec: codex-runtime-adapter-prework
superseded-by: null
---

# 0257. Relay Internal Adapter Generalization via Shared Abstract Base

## Status

Proposed

## Context

Relay's internal runtime adapter (`packages/relay/src/adapters/claude-code/`) is branded and typed specifically around Claude Code. `adapter-manager.ts` imports `ClaudeCodeAgentRuntimeLike`, `binding-router.ts` special-cases Claude dispatch, and the adapter's types are phrased in Claude-specific terms. Three generalization shapes were considered: (A) concrete siblings implementing a shared interface with no behavioral reuse, (B) a single generic `RuntimeAdapter<R extends AgentRuntime>` parameterized by runtime, (C) a shared abstract base class containing behavioral logic (streaming, delivery, retry) with runtime-specific thin subclasses.

## Decision

Promote the behavioral base (streaming, delivery, retry, queueing) into a shared abstract class under `packages/relay/src/adapters/`. `ClaudeCodeAdapter`, future `CodexAdapter`, and the fixture `TestModeAdapter` become thin subclasses that override only runtime-specific concerns. The Relay `adapter-manager.ts` accepts a map of runtime-type → adapter instance and dispatches by the session's owning runtime (resolved via the new `session_metadata` table from ADR 0255). `binding-router.ts` publishes on runtime-neutral subjects so routing is no longer special-cased by class name.

## Consequences

### Positive

- Shared behavior lives once; bug fixes and reliability improvements apply to every runtime adapter.
- Runtime-specific overrides are localized, legible, and debuggable.
- Adding a new runtime adapter requires only the runtime-specific subclass — no changes to manager or router.

### Negative

- An abstract base class can become a dumping ground if discipline slips; divergent runtime behaviors may leak into the base over time.
- Subclass overrides vs abstract-method contracts need clear documentation to prevent runtimes from accidentally skipping required hooks.
- External name `ClaudeCodeAdapter` remains stable to avoid breaking integrations; only internal types are renamed.
