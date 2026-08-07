# Level-Based Background Task State

## Problem Statement

DorkOS derives background-task state from edges — it watches individual events
go by and infers what's running (`system-event-mapper.ts:42-81` in the
claude-code adapter). Edge-derived state drifts: miss one event and the UI lies
until the next transition. The Claude Agent SDK now emits
`background_tasks_changed` (0.3.203): the full current set of background tasks
as a **level**, every time it changes — the same snapshot-over-inference
principle the durable SSE stream already applies to sessions.

## Design Principle: Runtime-Interface First

Per operator direction (2026-08-07): "what background work is this session
running" is a runtime-agnostic question:

- Define a generic background-task snapshot shape on the `AgentRuntime`
  event surface (Zod in `@dorkos/shared`)
- **claude-code**: native from `background_tasks_changed`; delete the
  edge-derivation code it replaces (no tolerated legacy patterns)
- **codex**: no equivalent event today — synthesize levels from thread items
  where possible, or report the capability as absent
- **opencode**: sidecar session status may cover part; same honest degradation
- Conformance: a case asserting each runtime either emits coherent snapshots
  or declares the capability unsupported (ADR-0310-style per-runtime degradation)

Related deferred item to evaluate here: `tool_progress.subagent_retry`
(0.3.214) — showing a subagent waiting out a rate limit instead of an opaque
stall fits the same "truthful activity state" surface.

## Research

- `research/runtime-upgrades/claude-agent-sdk/0.3.177-to-0.3.224/changelog.md` (0.3.203)
- `research/runtime-upgrades/claude-agent-sdk/0.3.177-to-0.3.224/impact-assessment.md`

## Dependencies

- **Blocked by**: `claude-agent-sdk-upgrade-0.3.224`

## Suggested Approach

1. Snapshot shape in shared; extend the runtime event mapping contract
2. claude-code: map the new event, remove edge-derived inference
3. Client: consume levels (Activity surface, session cards)

Effort: moderate.
