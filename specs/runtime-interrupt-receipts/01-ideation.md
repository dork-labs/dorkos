# Runtime Interrupt Receipts — Stop That Actually Stops

## Problem Statement

Today "Stop" is fire-and-forget: DorkOS asks the runtime to interrupt and hopes.
Users see the classic failure — "I pressed Stop and it kept going." The Claude
Agent SDK now provides the primitives to fix this properly: an interrupt
**receipt** (`Query.interrupt()` resolves with confirmation, 0.3.205) and
`cancel_queued` (0.3.219) to also flush messages queued behind the current turn.

## Design Principle: Runtime-Interface First

Per operator direction (2026-08-07): adopt native capabilities **through the
`AgentRuntime` seam, not around it**. The capability is defined generically on
`packages/shared/src/agent-runtime.ts` — e.g. `interrupt()` returning a typed
acknowledgement (`{ stopped: true, queuedDropped: n }` or a documented
"best-effort, unconfirmed" result) — and each runtime implements what it can:

- **claude-code**: native — SDK receipt + `cancel_queued`
- **codex**: 0.146.0 preserves interruption/replay state; map what the SDK
  exposes, degrade to best-effort otherwise
- **opencode**: sidecar abort endpoint; degrade to best-effort
- Conformance: extend `runtimeConformance` (`@dorkos/test-utils`) so every
  runtime's interrupt behavior — confirmed or explicitly best-effort — is
  contract-tested, with per-runtime degradation à la ADR-0310

The client then renders truthfully: a confirmed stop vs. "stop requested."

## Research

- `research/runtime-upgrades/claude-agent-sdk/0.3.177-to-0.3.224/changelog.md` (0.3.205, 0.3.219 entries)
- `research/runtime-upgrades/claude-agent-sdk/0.3.177-to-0.3.224/impact-assessment.md` (interrupt receipt section)
- Related: `SDKAssistantMessage.aborted` lands in the upgrade spec (honest truncation rendering); `tool_result_meta` (denied/cancelled tool classification) is deferred but belongs to this feature's orbit — reconsider here.

## Dependencies

- **Blocked by**: `claude-agent-sdk-upgrade-0.3.224` (must upgrade first)

## Suggested Approach

1. Extend `AgentRuntime` with a typed interrupt result; Zod schema in `@dorkos/shared`
2. Implement in claude-code adapter via the new SDK receipt; wire `cancel_queued`
3. Codex/opencode adapters return best-effort results honestly
4. Conformance cases + client UI states (stopping → stopped/unconfirmed)

Effort: moderate→significant (touches interface, three adapters, conformance, UI).
