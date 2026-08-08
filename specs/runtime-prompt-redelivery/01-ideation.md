# Runtime Prompt Redelivery After Transport Gaps

## Problem Statement

When a client disconnects while a permission prompt is pending, the prompt can
be lost — the agent sits blocked on a question nobody can see. DorkOS already
solved the event side with the durable per-session SSE stream (snapshot →
gap-free replay → live events). The Claude Agent SDK now offers the SDK-side
twin: `Query.reinitialize()` (0.3.195) redelivers pending permission prompts
after a transport gap.

## Design Principle: Runtime-Interface First

Per operator direction (2026-08-07): the capability is generic — "on
reattach/resume, re-surface any pending interactive requests" — expressed on the
`AgentRuntime` interface, not as a claude-code special case:

- **claude-code**: native via `Query.reinitialize()`
- **codex / opencode**: emit pending-permission state from whatever the SDK or
  sidecar retains on resume; where nothing is retained, the runtime declares
  the gap honestly (per-runtime degradation, ADR-0310 style)
- Conformance: a `runtimeConformance` case — "disconnect during pending
  permission → reconnect → prompt is re-surfaced or the session reports the
  drop" — so all runtimes are held to the same contract

This composes with the existing SSE hydration path: reattach triggers the
runtime-level redelivery, and the redelivered prompt rides the durable stream
like any live event.

## Research

- `research/runtime-upgrades/claude-agent-sdk/0.3.177-to-0.3.224/changelog.md` (0.3.195)
- `research/runtime-upgrades/claude-agent-sdk/0.3.177-to-0.3.224/impact-assessment.md`
- Related deferred item: `resumeDropsTurn` (0.3.223) tightens `resumeSessionAt` anchoring (`message-sender.ts:513`) — evaluate inside this spec.

## Dependencies

- **Blocked by**: `claude-agent-sdk-upgrade-0.3.224`

## Suggested Approach

1. Define the reattach contract on `AgentRuntime` (+ Zod types in shared)
2. claude-code: call `reinitialize()` on session reattach; map redelivered prompts into the SSE stream
3. Conformance + client verification (the session-switch self-test covers the UX)

Effort: moderate→significant.
