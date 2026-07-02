---
number: 306
title: 'OpenCode Adapter: Managed `opencode serve` Sidecar over SDK/SSE'
status: draft
created: 2026-07-02
spec: additional-agent-runtimes
superseded-by: null
---

# 306. OpenCode Adapter: Managed `opencode serve` Sidecar over SDK/SSE

## Status

Draft (auto-extracted from spec: additional-agent-runtimes)

## Context

OpenCode exposes three integration surfaces: a TUI, an ACP stdio mode, and a headless HTTP server (`opencode serve`, REST per OpenAPI 3.1 + SSE event stream) with an official SDK (`@opencode-ai/sdk`). Its session data now lives in an OpenCode-owned SQLite store (`~/.local/share/opencode/`) with a legacy-JSON migration engine and open reliability issues around growth and concurrent access. DorkOS needs streaming, session resume, permission-request forwarding, and session listing — and must not take a write-dependency on another product's private database schema.

## Decision

The OpenCode adapter (`apps/server/src/services/runtimes/opencode/`) manages a single `opencode serve` child process as a sidecar: lazily spawned on first use, health-checked, port/binary path from `runtimes.opencode` config, restarted with backoff on crash. All communication goes through `@opencode-ai/sdk` (REST + SSE); DorkOS sessions map 1:1 to OpenCode sessions, and session listing/history are read via the SDK. OpenCode's SQLite store is treated as opaque runtime-owned storage — never read or written directly. The ESLint SDK-confinement rule (mirroring the Claude rule) restricts `@opencode-ai/sdk` imports to the adapter directory.

## Consequences

### Positive

- Uses OpenCode's only officially supported programmatic surface; upgrades track the SDK, not private internals.
- The sidecar amortizes startup across sessions and gives one place for health/dependency reporting (`checkDependencies`).
- SSE event mapping parallels the existing SDK-event-mapper pattern from the Claude adapter — a familiar shape.

### Negative

- A child-process lifecycle to own: crash recovery, port conflicts, orphan cleanup on server shutdown.
- OpenCode session-store reliability issues become visible through DorkOS (mitigated but not fixed by SDK-only access).
- Local model quality remains bounded by model capability (tool-calling below ~14B parameters is unreliable) — a support/expectation concern, not an engineering one.
