---
number: 262
title: Recover Pending Interactions via Hybrid Pull + SSE Re-emit
status: draft
created: 2026-06-09
spec: permission-prompt-survives-session-switch
superseded-by: null
---

# 262. Recover Pending Interactions via Hybrid Pull + SSE Re-emit

## Status

Draft (auto-extracted from spec: permission-prompt-survives-session-switch)

## Context

Interactive prompts (tool approval, AskUserQuestion, MCP elicitation) are delivered to the web client as transient SSE control events and held server-side only in the in-memory per-session `pendingInteractions` map plus a deferred `canUseTool` promise. They are never persisted to JSONL and never replayed on reconnect, so a session switch, hard refresh, or background arrival drops the prompt from the UI while the agent stays blocked (DOR-73). The SDK's `canUseTool` is a live promise that cannot be serialized or recreated, so durability across a server restart is infeasible.

## Decision

Keep the server's in-memory `pendingInteractions` map as the single source of truth and make pending prompts recoverable via two complementary, idempotent paths that both feed one client renderer keyed by interaction id: (A) a side-effect-free `GET /api/sessions/:id/pending-interactions` the client pulls on session mount, and (B) re-emitting non-expired pending interactions as their native events on connect to the persistent ADR-0117 sync stream (`GET /:id/stream`). Both paths exclude expired interactions and carry a server-authoritative `remainingMs`. Persistence across server restart is explicitly out of scope (accepted loss boundary; sessions still derive from JSONL).

## Consequences

### Positive

- Pending prompts survive session switch, hard refresh, live SSE reconnect, and background→foreground, on any surface that opens the sync stream.
- No new source of truth and no new transport — reuses the ADR-0117 sync channel and the existing single-resolve (approve/deny/respond) pipeline; mirrors Temporal's Query (pull) + Signal (push).
- Idempotent, id-keyed rendering makes dual delivery safe (no duplicate cards, no double tool-execution).

### Negative

- Two recovery paths to maintain and keep in sync (shared selector + idempotent renderer mitigate this).
- Does not survive a server restart — the active query and its `canUseTool` promise are lost and the user must re-send.
- Requires storing a serializable snapshot + `startedAt` on each pending interaction.
