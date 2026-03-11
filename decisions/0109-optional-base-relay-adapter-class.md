---
number: 109
title: Optional BaseRelayAdapter Abstract Class for Adapter DX
status: draft
created: 2026-03-11
spec: relay-adapter-dx
superseded-by: null
---

# 109. Optional BaseRelayAdapter Abstract Class for Adapter DX

## Status

Draft (auto-extracted from spec: relay-adapter-dx)

## Context

Every relay adapter independently implements ~30 lines of identical boilerplate: status initialization, error recording, `getStatus()`, start/stop idempotency guards, and relay ref lifecycle. Three built-in adapters (Telegram, Claude Code, Webhook) all share this pattern. Third-party adapter authors will need to reverse-engineer it from existing adapters.

Research across 18 plugin systems (VS Code, Obsidian, Winston, Socket.IO, OpenTelemetry, Fastify) confirmed that optional abstract base classes are the standard approach for eliminating adapter boilerplate while preserving interface-first contracts.

## Decision

Add an optional `BaseRelayAdapter` abstract class that handles boilerplate. The `RelayAdapter` interface remains the contract — the class is a convenience. Adapters that implement `RelayAdapter` directly continue to work without modification.

The base class re-throws errors (does not silently catch). Per OpenTelemetry convention, the host (`AdapterRegistry`) handles error isolation. The base class tracks state but lets errors propagate so adapter authors see failures during development.

## Consequences

### Positive

- Eliminates ~30 lines of duplicated code per adapter
- Provides a "pit of success" for adapter authors — correct status tracking by default
- Consistent behavior across all adapters using the base class
- No migration required — existing adapters continue to work unchanged

### Negative

- Adds inheritance to the stack (some developers prefer composition)
- Base class must be maintained as the interface evolves
- Two valid approaches (interface vs base class) may create "which do I use?" confusion
