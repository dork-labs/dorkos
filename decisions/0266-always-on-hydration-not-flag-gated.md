---
number: 266
title: Session Hydration & Live Sync Are Always-On, Not Feature-Flag-Gated
status: proposed
created: 2026-06-10
spec: chat-stream-reconnection
superseded-by: null
---

# 266. Session Hydration & Live Sync Are Always-On, Not Feature-Flag-Gated

## Status

Proposed — 2026-06-11 (implemented by spec: chat-stream-reconnection; updated post-implementation to record the decision as built)

## Context

The client's entire reconnection/hydration path was gated behind off-by-default toggles: `enableCrossClientSync` ("Multi-window sync") gated the per-session SSE stream, and `enableMessagePolling` ("Background refresh") gated history polling. With both off — the default and the user's real configuration — a refreshed or non-sending client fetched history once and then received no live updates. Correctness was, in effect, an opt-in feature.

## Decision

Hydration and live streaming are a first-class, always-on capability and must never be gated by a preference. The **"Multi-window sync" toggle was removed entirely** — `enableCrossClientSync` no longer exists in the app store, settings UI, or stream wiring; the durable per-session `/events` stream and the global list stream (ADR-0264/0265) connect unconditionally (`use-session-stream.ts` attaches on mount, `session-events-handler.ts` has no flag check).

**"Background refresh" (`enableMessagePolling`) is kept but default-OFF and re-described** as an opt-in client-side polling fallback for picking up sessions driven outside DorkOS (e.g. the Claude Code CLI) in environments where server-side file-watch discovery is unreliable — not as a correctness gate (`AdvancedTab.tsx`: "Messages stream in live and stay in sync across windows automatically. This optional setting adds an extra polling fallback for sessions running outside DorkOS.").

Consequence of always-on: the DOR-73 recovery pull endpoint (`GET /api/sessions/:id/pending-interactions`) and the legacy flag-gated sync channel (`GET /:id/stream`) became redundant — the always-on `/events` snapshot already carries `pendingInteractions` on every connect — and both were deleted (see ADR-0262 amendment).

## Consequences

### Positive

- The reported symptoms (no live updates after refresh / in another window) are fixed by default with no user action; correctness is no longer a setting.
- Cleaner settings surface and less code: one delivery path, no flag branches, two redundant endpoints removed.

### Negative

- Removing a persisted preference orphans the old localStorage key and required settings-UI changes.
- The retained polling fallback's purpose must stay clearly documented so it is not mistaken for a correctness switch.
- Every open session view now holds a durable SSE connection unconditionally; the hidden-tab visibility optimization (release and reconnect) exists to keep that honest against the browser connection budget.
