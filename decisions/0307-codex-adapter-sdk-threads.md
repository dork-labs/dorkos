---
number: 307
title: 'Codex Adapter: SDK Threads Mapped to DorkOS Sessions'
status: draft
created: 2026-07-02
spec: additional-agent-runtimes
superseded-by: null
---

# 307. Codex Adapter: SDK Threads Mapped to DorkOS Sessions

## Status

Draft (auto-extracted from spec: additional-agent-runtimes)

## Context

The OpenAI Codex SDK (`@openai/codex-sdk`) wraps the Rust `codex` CLI as a managed subprocess speaking JSONL over stdio. Its unit of conversation is the thread: `startThread()` / `resumeThread(id)` / `runStreamed()` yielding seven structured event types, with thread state persisted under `~/.codex/sessions`. Auth reuses `codex login` state (ChatGPT account OAuth) or an API key. DorkOS sessions are keyed by session id with runtime binding in `session_metadata` (ADR-0255).

## Decision

The Codex adapter (`apps/server/src/services/runtimes/codex/`) maps one DorkOS session to one Codex thread. The thread id is recorded as adapter-owned session state; `ensureSession` resolves to `startThread` (new) or `resumeThread` (existing), and `sendMessage` feeds `runStreamed()` events through an event mapper into the shared `StreamEvent` vocabulary. Approval/sandbox parameters are passed explicitly per the SDK's post-0.132.0 contract (no implicit defaults). `checkDependencies` verifies the CLI binary and login state; auth flows are delegated to `codex login` on the host (consistent with the delegate-to-host-login stance from the agent-auth research). The SDK version is pinned and its import confined to the adapter directory by ESLint.

## Consequences

### Positive

- Official, funded SDK with a stable published API surface (`startThread`/`resumeThread`/`runStreamed` unchanged across 0.4x→0.14x).
- Thread resume gives real session continuity without DorkOS owning transcript storage.
- Structured event stream maps cleanly onto the existing `StreamEvent` types.

### Negative

- No local/open-source model support — the adapter is only as available as OpenAI access.
- Near-continuous SDK release cadence with occasional breaking changes (0.132.0) demands a pinned version and an upgrade cadence.
- Known CLI-side logging-volume defect (June 2026, `logs_2.sqlite` unbounded writes) must be re-verified at implementation time; mitigate via config if unpatched.
