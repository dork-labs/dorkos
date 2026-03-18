---
number: 140
title: Use Ephemeral Lookup Map for Telegram Callback Data
status: draft
created: 2026-03-18
spec: slack-tool-approval
superseded-by: null
---

# 0140. Use Ephemeral Lookup Map for Telegram Callback Data

## Status

Draft (auto-extracted from spec: slack-tool-approval)

## Context

Telegram's `callback_data` field for inline keyboard buttons is limited to 64 bytes. The approval flow needs to encode `toolCallId`, `sessionId`, and `agentId` — which collectively exceed this limit. Options considered: truncating IDs (lossy, collision risk), encoding only a lookup key (requires server-side state), or using a different Telegram interaction mechanism.

## Decision

Use an in-memory `callbackIdMap` (`Map<string, { toolCallId, sessionId, agentId, expiresAt }>`) in the Telegram adapter. When rendering an approval keyboard, generate a 12-character random key, store the full IDs in the map with a 15-minute TTL, and encode only the short key in `callback_data`. On callback query, look up the key to retrieve full IDs.

## Consequences

### Positive

- Stays well within the 64-byte `callback_data` limit
- No collision risk (12-char random key + TTL eviction)
- Aligns with the server's 10-minute approval timeout (15-minute TTL provides margin)
- No persistent storage needed — ephemeral state matches ephemeral deferred promises

### Negative

- Server restart clears the map, making pending approval buttons unresponsive (acceptable: deferred promises also clear on restart)
- Memory usage is negligible (~200 bytes per entry, typically < 10 concurrent)
- Requires TTL-based reaping to prevent unbounded growth
