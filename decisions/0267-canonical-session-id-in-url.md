---
number: 267
title: Canonical Session Id in the URL via Resolve-and-Rewrite
status: draft
created: 2026-06-10
spec: chat-stream-reconnection
superseded-by: null
---

# 267. Canonical Session Id in the URL via Resolve-and-Rewrite

## Status

Draft (auto-extracted from spec: chat-stream-reconnection)

## Context

A new session keeps a client-generated UUID in `?session=` until the first message; the runtime then assigns its own canonical session id (the JSONL filename for Claude Code), which differs. The same session is therefore reachable by two ids, and anything keyed off the URL id (history lookups, cross-client sync, breadcrumbs) can mismatch — a direct hazard for reliable URL-entry and hard-refresh hydration (DOR-74).

## Decision

Resolve the client UUID to the runtime's canonical session id at session creation / first message (returned by the trigger POST) and **rewrite the URL** with `router.replace` (no history entry) to the canonical id. The URL holds exactly one canonical id thereafter; entry and refresh always hydrate against the same id. Rejected the server-side alias-both-ids approach because it leaves two ids valid indefinitely and forces every id-keyed path to remember to alias — a permanent foot-gun.

## Consequences

### Positive

- Eliminates the dual-id bug class at its source; URLs become stable and shareable.
- Refresh/URL-entry hydration is unambiguous.

### Negative

- A freshly-created session's URL changes once after its first message.
- Requires the trigger POST to return the canonical id and the client to perform the rewrite at the right moment.
