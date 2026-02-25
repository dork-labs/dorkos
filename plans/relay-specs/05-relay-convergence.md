---
title: "Relay Convergence"
spec: 5
order: 4
status: done
blockedBy: [3, 4, 6]
blocks: []
parallelWith: []
litepaperPhase: "Phase 5 — Convergence"
complexity: high
risk: high
estimatedFiles: 15-25
newPackages: []
primaryWorkspaces: ["apps/server", "apps/client", "packages/relay", "packages/shared"]
touchesServer: true
touchesClient: true
migrationRisk: >
  This spec changes how Pulse dispatching and Console messaging work internally.
  Both are critical paths. The migration must be backwards-compatible — existing
  API endpoints continue to function during the transition. Test the happy path
  AND the fallback path thoroughly. Consider a feature flag for each migration
  (RELAY_PULSE_DISPATCH, RELAY_CONSOLE_ENDPOINT) so they can be enabled independently.
verification:
  - "Pulse dispatches via Relay — messages appear in Relay inbox, agent sessions start via runtime adapter"
  - "Pulse still works if Relay is disabled (fallback to direct AgentManager call)"
  - "Console sends messages through Relay endpoint — chat still works end-to-end"
  - "Console still works if Relay console endpoint is disabled (fallback to HTTP POST)"
  - "Message trace shows full journey: sender → budget check → delivery → runtime adapter → response"
  - "All existing tests still pass (no regressions)"
  - "CLAUDE.md and contributing docs reflect the converged architecture"
notes: >
  This is the highest-risk spec — it touches the primary user interaction path
  (Console) and the autonomous execution path (Pulse). Plan for feature flags
  on each migration so they can be enabled independently and rolled back if
  needed. The AgentRuntimeAdapter interface and Claude Code adapter are built
  in Spec 6 — this spec uses them for Pulse dispatch and Console migration.
  Lazy activation is handled by the runtime adapter (Spec 6), not by this spec.
---

# Spec 5: Relay Convergence

## Prompt

```
Migrate Pulse dispatching and Console messaging to flow through Relay — completing the convergence where all DorkOS communication uses a single transport.

This is the final Relay spec. Specs 1-4 built the message bus, integrated it, hardened it, and connected external channels. Spec 6 built the Claude Code runtime adapter. This spec migrates existing DorkOS subsystems to use Relay as their transport, and adds observability tooling for the complete system.

GOALS:
- Migrate Pulse scheduled dispatch to use Relay — instead of calling AgentManager directly, Pulse publishes a message to the target agent's Relay subject with a budget envelope. The Claude Code runtime adapter (Spec 6) handles session creation when messages arrive.
- Migrate Console chat to use Relay — Console becomes relay.human.console.{clientId}, just another endpoint on the bus. Chat messages, tool approvals, and status updates flow through Relay instead of direct HTTP POST to the agent manager.
- Implement delivery metrics and message tracing — queryable from SQLite and exposed via API. Trace a message's full journey: sender → budget check → delivery → runtime adapter → response.
- Implement a message trace UI in the client — click any message to see its full delivery path, budget decrements, timing, and any errors.
- Update all documentation to reflect the converged architecture (CLAUDE.md, contributing guides, API reference)

INTENDED OUTCOMES:
- Pulse dispatches through Relay: every scheduled run has a delivery receipt, budget envelope, and dead letter handling — for free
- Console is a Relay endpoint: one message log, one SSE stream, one audit trail for everything
- Any message can be traced end-to-end: when was it sent, what budget did it have, when was it delivered, when was it processed, what was the response
- All DorkOS communication is unified through Relay — the architecture diagram in the litepaper is fully realized

KEY MIGRATION STRATEGY:
The design doc specifies a gradual migration:
- Phase 1 (already done in Specs 1-2): Inter-agent messages go through Relay. Pulse keeps calling AgentManager directly.
- Phase 2 (done in Spec 6): Claude Code runtime adapter handles agent message delivery — messages arriving at relay.agent.> subjects trigger agent sessions.
- Phase 3 (this spec): Pulse publishes to Relay instead of calling AgentManager directly. Console switches from HTTP POST /api/sessions/:id/messages to publishing through Relay. The SSE sync stream merges with Relay's event stream.

The migrations should be backwards-compatible during transition — existing API endpoints continue to work, but internally route through Relay.

REFERENCE DOCUMENTS:
- meta/modules/relay-litepaper.md — "What Relay Enables" section (Console as endpoint, Pulse through Relay, agent execution as subscription), Phase 4 roadmap
- docs/plans/2026-02-24-relay-design.md — Pulse migration path (lines 344-360), Engine → Relay migration (lines 479-484), Agent Runtime Adapter (lines 487-496), observability (lines 306-330)
- docs/plans/2026-02-24-litepaper-review.md — OQ-2 (lazy activation — what happens when a message arrives for an offline agent?) is directly relevant to the Engine subscription model
- meta/dorkos-litepaper.md — architecture diagram and workflow example show the converged state

CODEBASE AREAS TO STUDY:
- apps/server/src/services/scheduler-service.ts — current Pulse dispatch: this.agentManager.createSession(). This becomes relay.publish()
- apps/server/src/services/agent-manager.ts — current session creation flow. The SDK query() call stays, but it's now triggered by a Relay message arrival instead of a direct function call
- apps/server/src/services/sdk-event-mapper.ts — the mapping boundary where an AgentRuntimeAdapter interface would go
- apps/server/src/routes/sessions.ts — current Console → AgentManager flow via HTTP POST. This eventually routes through Relay
- apps/server/src/services/session-broadcaster.ts — current SSE sync. Merges with Relay's event stream
- apps/client/src/layers/features/chat/model/use-chat-session.ts — current client-side message sending. Would switch to Relay transport

RISKS AND CONSIDERATIONS:
- Console migration is the highest-risk change — it touches the primary user interaction path. Must be backwards-compatible.
- Message tracing adds observability overhead — ensure it doesn't measurably slow down delivery
- The Claude Code runtime adapter (Spec 6) must be working before this spec can migrate Pulse dispatch — verify adapter handles session creation correctly

OUT OF SCOPE:
- Additional external adapters beyond what's built in Spec 4
- Additional runtime adapters (Claude Code adapter built in Spec 6; Codex/OpenCode adapters are future work)
- Multi-user support (Console uses clientId, not userId — DorkOS is single-user)
```

## Context for Review

This is the most architecturally impactful spec — it changes how Pulse and Console work. The /ideate session should focus on:
- The backwards-compatibility strategy for Console migration (how do both paths coexist?)
- How the Claude Code runtime adapter (Spec 6) handles Pulse dispatch messages
- Message tracing data model — what do you store, where, and how do you query it?
- The SSE stream merge — how does Relay's event stream replace/augment the existing session sync?
