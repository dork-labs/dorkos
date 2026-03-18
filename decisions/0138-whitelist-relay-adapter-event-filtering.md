---
number: 138
title: Whitelist Relay Adapter Event Filtering
status: draft
created: 2026-03-17
spec: relay-adapter-event-whitelist
superseded-by: null
---

# 138. Whitelist Relay Adapter Event Filtering

## Status

Draft (auto-extracted from spec: relay-adapter-event-whitelist)

## Context

Relay adapters (Slack, Telegram) use a blacklist (`SILENT_EVENT_TYPES`) to filter out SDK events that shouldn't be forwarded to chat platforms. When the SDK expanded from ~15 to 29 event types, the 14 new types were not added to the blacklist, causing raw JSON to leak into Slack and Telegram channels. The blacklist approach is fundamentally "fail-open" — unknown events pass through and get serialized.

## Decision

Delete `SILENT_EVENT_TYPES` entirely and flip to an implicit whitelist model. Adapters explicitly handle only the events they need (`text_delta`, `error`, `done`) and silently drop everything else with an unconditional `return { success: true }` after the handler chain. Unknown or future event types are silently discarded by default — no maintenance when the SDK adds new events.

## Consequences

### Positive

- Forward-compatible: new SDK event types are silently ignored without code changes
- Fail-closed: unknown events cannot leak to users
- Simpler: removes the `SILENT_EVENT_TYPES` concept and its maintenance burden
- No behavioral change for existing handled events (text_delta, error, done)

### Negative

- Less self-documenting: the whitelist is implicit in the handler chain rather than an explicit set
- If a future event type should be forwarded (e.g., a new user-visible event), the adapter must be updated — silent drop is the default
