---
number: 267
title: Canonical Session Id in the URL via Resolve-and-Rewrite
status: proposed
created: 2026-06-10
spec: chat-stream-reconnection
superseded-by: null
---

# 267. Canonical Session Id in the URL via Resolve-and-Rewrite

## Status

Proposed — 2026-06-11 (implemented by spec: chat-stream-reconnection; updated post-implementation to record the decision as built)

## Context

A new session keeps a client-generated UUID in `?session=` until the first message; the runtime then assigns its own canonical session id (the JSONL filename for Claude Code), which differs. The same session is therefore reachable by two ids, and anything keyed off the URL id (history lookups, the durable stream subscription, breadcrumbs) can mismatch — a direct hazard for reliable URL-entry and hard-refresh hydration (DOR-74).

## Decision

Resolve the client UUID to the canonical id and **rewrite the URL in place** (history `replace`, no new entry). Because the trigger POST's canonical id is only best-effort (ADR-0264 — the Claude adapter usually assigns the real SDK id when the init message lands, AFTER the 202 has resolved), the rewrite fires at **both observation points**:

1. **Early (202 path)**: when `POST /messages` returns a different `sessionId`, the submit path (`use-session-submit.ts`) re-attaches the durable stream to the canonical id, migrates client-authored continuity, swaps the optimistic sidebar row, and rewrites the URL.
2. **Late (retire announce — the common Claude path)**: the server re-keys the projector registry (`rekeyProjector` moves the SAME instance, so the in-flight feed and open subscriptions keep working) and re-announces on the global stream with `session_status.retiredSessionId` (ADR-0265). The client list store records the mapping in its `rekeys` map (`session-list-store.ts`) and drops all state under the retired UUID; `useSessionRekeyRedirect` (`use-session-stream.ts`) watches that mapping for the active session and performs the same in-place rewrite.

Both points funnel continuity through `migrateSessionContinuity` (`session-stream-store.ts`): the compose-next queue, the optimistic user message, and the trigger latch follow the canonical id (idempotent — the second observation point sees an empty source and no-ops), so a message queued against the throwaway UUID is not silently lost (NF-2, acceptance run 20260611-145454). The URL holds exactly one canonical id thereafter; a canonical id never retires, so the redirect fires at most once per session.

We rejected the server-side alias-both-ids approach because it leaves two ids valid indefinitely and forces every id-keyed path to remember to alias — a permanent foot-gun. The one-time registry rekey is the only server-side id move, and it is explicitly a move, not an alias.

## Consequences

### Positive

- Eliminates the dual-id bug class at its source; URLs become stable and shareable, and refresh/URL-entry hydration is unambiguous.
- Client-authored first-turn state (queue, optimistic message, trigger latch) survives the rekey instead of orphaning under a dead id.

### Negative

- A freshly-created session's URL changes once after its first message.
- Two observation points must stay behaviorally identical; the late path depends on the global stream being connected (always-on per ADR-0266, but a disconnected window misses the announce until reconnect).
- The migrated continuity state is in-memory only: a hard refresh during the rekey window loses a queued/optimistic message. Durable queueing is DOR-82 scope, not this decision's.
