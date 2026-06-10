---
number: 266
title: Session Hydration & Live Sync Are Always-On, Not Feature-Flag-Gated
status: draft
created: 2026-06-10
spec: chat-stream-reconnection
superseded-by: null
---

# 266. Session Hydration & Live Sync Are Always-On, Not Feature-Flag-Gated

## Status

Draft (auto-extracted from spec: chat-stream-reconnection)

## Context

The client's entire reconnection/hydration path is gated behind off-by-default toggles: `enableCrossClientSync` ("Multi-window sync", `use-session-history.ts:157`) gates the per-session SSE stream, and `enableMessagePolling` ("Background refresh", `:99`) gates history polling. With both off — the default and the user's real configuration — a refreshed or non-sending client fetches history once and then receives no live updates. Correctness was, in effect, an opt-in feature.

## Decision

Hydration and live streaming are a first-class, always-on capability and must never be gated by a preference. **Remove the "Multi-window sync" toggle** (`enableCrossClientSync`, its store field, and the `syncUrl` gate); cross-client live sync via the durable + global streams becomes the default. **Keep "Background refresh"** (`enableMessagePolling`) but **default OFF and re-describe it** as an opt-in client-side polling _fallback_ for picking up sessions driven outside DorkOS (e.g. the Claude Code CLI) in environments where server-side file-watch discovery is unreliable — not as a correctness gate, since server-side discovery is now the primary mechanism.

## Consequences

### Positive

- The reported symptoms (no live updates after refresh / in another window) are fixed by default with no user action.
- Cleaner settings surface; "it just works" out of the box.

### Negative

- Removing a persisted preference requires a client store migration and settings-UI changes.
- The retained polling fallback's purpose must be clearly documented so it isn't mistaken for a correctness switch.
