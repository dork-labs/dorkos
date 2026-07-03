---
number: 308
title: 'OpenCode Adapter: Managed `opencode serve` Sidecar over SDK/SSE'
status: accepted
created: 2026-07-02
spec: additional-agent-runtimes
superseded-by: null
---

# 308. OpenCode Adapter: Managed `opencode serve` Sidecar over SDK/SSE

## Status

Accepted (implemented in spec: additional-agent-runtimes, `@opencode-ai/sdk@1.17.13`)

## Context

OpenCode exposes three integration surfaces: a TUI, an ACP stdio mode, and a headless HTTP server (`opencode serve`, REST per OpenAPI 3.1 + SSE event stream) with an official SDK (`@opencode-ai/sdk`). Its session data now lives in an OpenCode-owned SQLite store (`~/.local/share/opencode/`) with a legacy-JSON migration engine and open reliability issues around growth and concurrent access. DorkOS needs streaming, session resume, permission-request forwarding, and session listing — and must not take a write-dependency on another product's private database schema.

Verification against the upstream source at the pinned tag confirmed two decisive facts: a **single** server instance honors per-session working directories (nearly every SDK call accepts a `directory` query param, resolved per-request server-side), so no per-cwd instance pool is needed; and OpenCode's permission defaults are **permissive**, so the sidecar must be spawned with an explicit ask-config to make approvals the safe default.

## Decision

The OpenCode adapter (`apps/server/src/services/runtimes/opencode/`) manages a single `opencode serve` child process as a sidecar: lazily spawned on first use, health-checked (readiness parsed from its stdout listen line, so `--port=0` ephemeral binding is safe), port/binary path from `runtimes.opencode` config, restarted with capped exponential backoff on crash, and killed on server shutdown. It is spawned directly (not via the SDK's `createOpencodeServer` helper) so DorkOS can inject a per-boot `OPENCODE_SERVER_PASSWORD` (localhost-only Basic auth, never tunnel-exposed) and an `OPENCODE_CONFIG_CONTENT` ask-ruleset (`edit`/`bash`/`webfetch` → `ask`) that overrides OpenCode's permissive defaults. All communication goes through `@opencode-ai/sdk` (REST + a single global SSE subscription demultiplexed per session); DorkOS sessions map 1:1 to OpenCode sessions via a deterministic UUIDv5 translation (OpenCode `ses_*` ids are not UUIDs), and session listing/history are read via the SDK. OpenCode's SQLite store is treated as opaque runtime-owned storage — never read or written directly. The ESLint SDK-confinement rule (mirroring the Claude rule) restricts `@opencode-ai/sdk` imports to the adapter directory.

## Consequences

### Positive

- Uses OpenCode's only officially supported programmatic surface; upgrades track the SDK, not private internals.
- The sidecar amortizes startup across sessions and gives one place for health/dependency reporting (`checkDependencies`).
- A single instance suffices (per-request directory routing), avoiding a per-cwd pool; SSE event mapping parallels the existing SDK-event-mapper pattern from the Claude adapter — a familiar shape.

### Negative

- A child-process lifecycle to own: crash recovery, port conflicts, orphan cleanup on server shutdown, and a global-stream resubscribe on sidecar restart (a restart mints a new client/password).
- OpenCode session-store reliability issues become visible through DorkOS (mitigated but not fixed by SDK-only access).
- Local model quality remains bounded by model capability (tool-calling below ~14B parameters is unreliable) — a support/expectation concern, not an engineering one.
