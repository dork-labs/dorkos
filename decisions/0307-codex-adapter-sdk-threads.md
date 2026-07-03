---
number: 307
title: 'Codex Adapter: SDK Threads Mapped to DorkOS Sessions'
status: accepted
created: 2026-07-02
spec: additional-agent-runtimes
superseded-by: null
---

# 307. Codex Adapter: SDK Threads Mapped to DorkOS Sessions

## Status

Accepted (implemented in spec: additional-agent-runtimes, `@openai/codex-sdk@0.142.5`)

## Context

The OpenAI Codex SDK (`@openai/codex-sdk`) wraps the Rust `codex` CLI as a managed subprocess speaking JSONL over stdio. Its unit of conversation is the thread: `startThread()` / `resumeThread(id)` / `runStreamed()` yielding structured events (verified at 0.142.5 to be **eight** event types, not seven), with thread state persisted under `~/.codex/sessions`. Auth reuses `codex login` state (ChatGPT account OAuth) or an API key. DorkOS sessions are keyed by session id with runtime binding in `session_metadata` (ADR-0255).

Two SDK realities were confirmed by live probing during implementation (the SDK vendors the pinned `codex` binary): (1) the SDK exposes **no thread listing or reading API** — `Codex` offers only `startThread`/`resumeThread`, and `Thread` offers only `id`/`run`/`runStreamed`; (2) the exec-mode SDK has **no interactive tool-approval channel** (stdin closes after the prompt, and approval-needing calls auto-cancel), so the sandbox mode is the enforcement boundary.

## Decision

The Codex adapter (`apps/server/src/services/runtimes/codex/`) maps one DorkOS session to one Codex thread. The session↔thread map is a dedicated `codex_threads` SQLite table (first-write-wins, `session_metadata` untouched); `ensureSession` resolves to `startThread` (new) or `resumeThread` (existing), the thread id being persisted mid-turn when `thread.started` first observes it. `sendMessage` feeds `runStreamed()` events through an event mapper into the shared `StreamEvent` vocabulary. Approval/sandbox parameters are passed explicitly per the SDK's post-0.132.0 contract; because there is no interactive approval channel, the runtime declares `supportsToolApproval: false` and projects `approvalPolicy: 'never'` with the sandbox mode (`read-only`/`workspace-write`/`danger-full-access`) as the durable permission-mode mapping. Since the SDK cannot list or read threads, session discovery is an in-memory registry and history is reconstructed from the EventLog. `checkDependencies` verifies the CLI binary and login state; auth flows are delegated to `codex login` on the host (consistent with the delegate-to-host-login stance from the agent-auth research). The SDK version is pinned and its import confined to the adapter directory by ESLint.

## Consequences

### Positive

- Official, funded SDK with a stable published API surface (`startThread`/`resumeThread`/`runStreamed` unchanged across 0.4x→0.14x).
- Thread resume gives real session continuity without DorkOS owning transcript storage.
- Structured event stream maps cleanly onto the existing `StreamEvent` types.

### Negative

- No local/open-source model support — the adapter is only as available as OpenAI access.
- No SDK thread-listing API means past Codex sessions are **not rediscovered after a DorkOS server restart** (resume of a known session still works via the durable `codex_threads` map, and history reconstructs from the EventLog); documented as a user-facing limitation.
- No interactive tool approvals — the sandbox mode is the only guardrail; capability flags gate the approval UI off honestly.
- Near-continuous SDK release cadence with occasional breaking changes (0.132.0) demands a pinned version and an upgrade cadence.
- Known CLI-side logging-volume defect (June 2026, `logs_2.sqlite` unbounded writes) is only partially patched at 0.142.5 (`#29599` lands in 0.143.0); re-pin to ≥0.143.0 during a stabilization pass.
