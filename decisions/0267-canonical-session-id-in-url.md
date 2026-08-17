---
number: 267
title: Canonical Session Id in the URL via Resolve-and-Rewrite
status: accepted
created: 2026-06-10
spec: chat-stream-reconnection
superseded-by: null
---

# 267. Canonical Session Id in the URL via Resolve-and-Rewrite

## Status

Accepted — 2026-06-11 (implemented by spec: chat-stream-reconnection; updated post-implementation to record the decision as built)

## Context

A new session keeps a client-generated UUID in `?session=` until the first message; the runtime then assigns its own canonical session id (the JSONL filename for Claude Code), which differs. The same session is therefore reachable by two ids, and anything keyed off the URL id (history lookups, the durable stream subscription, breadcrumbs) can mismatch — a direct hazard for reliable URL-entry and hard-refresh hydration (DOR-74).

## Decision

Resolve the client UUID to the canonical id and **rewrite the URL in place** (history `replace`, no new entry). Because the trigger POST's canonical id is only best-effort (ADR-0264 — the Claude adapter usually assigns the real SDK id when the init message lands, AFTER the 202 has resolved), the rewrite fires at **both observation points**:

1. **Early (202 path)**: when `POST /messages` returns a different `sessionId`, the submit path (`use-session-submit.ts`) re-attaches the durable stream to the canonical id, migrates client-authored continuity, swaps the optimistic sidebar row, and rewrites the URL.
2. **Late (retire announce — the common Claude path)**: the server re-keys the projector registry (`rekeyProjector` moves the SAME instance, so the in-flight feed and open subscriptions keep working) and re-announces on the global stream with `session_status.retiredSessionId` (ADR-0265). The client list store records the mapping in its `rekeys` map (`session-list-store.ts`) and drops all state under the retired UUID; `useSessionRekeyRedirect` (`use-session-stream.ts`) watches that mapping for the active session and performs the same in-place rewrite.

Both points funnel continuity through `migrateSessionContinuity` (`session-stream-store.ts`): the compose-next queue, the optimistic user message, and the trigger latch follow the canonical id (idempotent — the second observation point sees an empty source and no-ops), so a message queued against the throwaway UUID is not silently lost (NF-2, acceptance run 20260611-145454). The URL holds exactly one canonical id thereafter; a canonical id never retires, so the redirect fires at most once per session.

We rejected the server-side alias-both-ids approach because it leaves two ids valid indefinitely and forces every id-keyed path to remember to alias — a permanent foot-gun. The one-time registry rekey is the only server-side id move, and it is explicitly a move, not an alias.

## Amendment — 2026-08-16 (DOR-1262): the rekey leaves a bounded redirect behind

Status stays **accepted**; this narrows one consequence of the move, it does not reopen the decision.

The move alone was not enough. The 202 for a brand-new session carries the **request UUID** whenever the runtime assigns its canonical id after the response has already gone out (measured at ~2s on Claude Code), so a caller can legitimately hold only the retired id. Every other layer already accepted that id — the runtime resolves it, the routes accept it, the write lock follows it — and the projector registry was the one place that did not: a lookup under the retired id **minted a fresh empty projector**. The runtime's next re-announce of the canonical id then hit `rekeyProjector`'s collision branch, which terminated the real projector and ended its live `/events` subscribers. The `widget-round-trip` eval failed on exactly that (2026-08-16): a widget click posted under the id the client was given split the session in two and killed the canonical stream.

So `rekeyProjector` now records a **retired → canonical redirect**, consulted by every id-keyed lookup in the registry (`getOrCreateProjector`, `peekProjector`, `disposeProjector`, and `rekeyProjector` itself). A retired id can never mint a projector again.

This is **not** the indefinite dual-id aliasing rejected above:

- it is in-memory and one-directional (retired → canonical, never the reverse);
- it is born from the same one-time move, not from a second source of truth;
- it chains flat, so a session renamed twice resolves in one hop;
- it is cleared when the canonical projector is disposed, so a retired id never outlives its session;
- and there is still exactly ONE projector per session — the alias is on the key, not on the state.

The foot-gun the original rejection was about — every id-keyed path having to remember to alias — is avoided precisely because the redirect lives at the registry, so no call site has to know. The cockpit is unaffected: it still follows the canonical-id re-announce and rewrites its URL. The collision branch survives as a defensive fallback and is documented as such.

## Consequences

### Positive

- Eliminates the dual-id bug class at its source; URLs become stable and shareable, and refresh/URL-entry hydration is unambiguous.
- Client-authored first-turn state (queue, optimistic message, trigger latch) survives the rekey instead of orphaning under a dead id.

### Negative

- A freshly-created session's URL changes once after its first message.
- Two observation points must stay behaviorally identical; the late path depends on the global stream being connected (always-on per ADR-0266, but a disconnected window misses the announce until reconnect).
- The migrated continuity state is in-memory only: a hard refresh during the rekey window loses a queued/optimistic message. Durable queueing is DOR-82 scope, not this decision's.
