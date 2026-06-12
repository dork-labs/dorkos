---
number: 262
title: Recover Pending Interactions via Hybrid Pull + SSE Re-emit
status: proposed
created: 2026-06-09
spec: permission-prompt-survives-session-switch
superseded-by: null
---

# 262. Recover Pending Interactions via Hybrid Pull + SSE Re-emit

## Status

Proposed — amended 2026-06-11: the dual-path delivery mechanism was replaced by the snapshot+replay stream (ADR-0264); see Amendment. The surviving substance (in-memory source of truth, server-authoritative countdown, restart loss boundary) remains in force.

## Context

Interactive prompts (tool approval, AskUserQuestion, MCP elicitation) are delivered to the web client as transient SSE control events and held server-side only in the in-memory per-session `pendingInteractions` map plus a deferred `canUseTool` promise. They are never persisted to JSONL and never replayed on reconnect, so a session switch, hard refresh, or background arrival drops the prompt from the UI while the agent stays blocked (DOR-73). The SDK's `canUseTool` is a live promise that cannot be serialized or recreated, so durability across a server restart is infeasible.

## Decision

Keep the server's in-memory `pendingInteractions` map as the single source of truth and make pending prompts recoverable via two complementary, idempotent paths that both feed one client renderer keyed by interaction id: (A) a side-effect-free `GET /api/sessions/:id/pending-interactions` the client pulls on session mount, and (B) re-emitting non-expired pending interactions as their native events on connect to the persistent ADR-0117 sync stream (`GET /:id/stream`). Both paths exclude expired interactions and carry a server-authoritative `remainingMs`. Persistence across server restart is explicitly out of scope (accepted loss boundary; sessions still derive from JSONL).

## Amendment (2026-06-11)

Spec `chat-stream-reconnection` (ADR-0263/0264/0266) **removed both delivery paths**: the Path A pull endpoint (`GET /api/sessions/:id/pending-interactions`) and the Path B connect re-emit (the ADR-0117 `GET /:id/stream` channel and its `pending-interaction-events` helper) no longer exist. Pending-interaction recovery now flows through the single always-on delivery path:

- the `/events` cold-connect snapshot carries `pendingInteractions: PendingInteractionDTO[]` (`SessionSnapshotSchema`, `packages/shared/src/session-stream.ts`), and
- the live `interaction_resolved` event removes a resolved/cancelled card on every connected window without waiting for the next snapshot.

What this ADR decided **survives** the mechanism swap: the in-memory map is still the single source of truth (the projector mirrors it and delegates expiry to the same `listPendingInteractions` selector, `apps/server/src/services/session/pending-interactions.ts`); each pending interaction still stores a serializable snapshot + `startedAt`; the server-authoritative `startedAt`/`remainingMs` countdown rides both the snapshot DTOs and the live interaction events (`approval_required`/`question_prompt`/`elicitation_prompt`); rendering stays idempotent by interaction id; and a server restart still loses the active `canUseTool` promise (accepted loss boundary, restated in ADR-0264).

What is **superseded** is the title mechanism itself — hybrid pull + re-emit — replaced by snapshot+replay because two recovery paths converging on one renderer was exactly the duplication ADR-0264's single delivery path collapses.

## Consequences

### Positive

- Pending prompts survive session switch, hard refresh, live SSE reconnect, and background→foreground, on any surface that opens the sync stream.
- No new source of truth and no new transport — reuses the ADR-0117 sync channel and the existing single-resolve (approve/deny/respond) pipeline; mirrors Temporal's Query (pull) + Signal (push).
- Idempotent, id-keyed rendering makes dual delivery safe (no duplicate cards, no double tool-execution).

### Negative

- Two recovery paths to maintain and keep in sync (shared selector + idempotent renderer mitigate this). _Amendment: this cost is what motivated replacing the mechanism with ADR-0264's single path._
- Does not survive a server restart — the active query and its `canUseTool` promise are lost and the user must re-send.
- Requires storing a serializable snapshot + `startedAt` on each pending interaction.
