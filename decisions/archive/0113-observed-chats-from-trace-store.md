---
number: 113
title: Observed Chats Derived from Trace Store
status: archived
created: 2026-03-11
spec: adapter-binding-ux-overhaul
superseded-by: null
---

# 113. Observed Chats Derived from Trace Store

## Status

Draft (auto-extracted from spec: adapter-binding-ux-overhaul)

## Context

The BindingDialog needs a list of chat IDs that have sent messages through a given adapter, so users can create chat-specific routing rules without manually entering IDs. This data could come from a dedicated chat tracking store, from the adapter itself (querying the external service), or from existing trace/message history.

## Decision

Derive observed chats from the existing trace store metadata. Traces already contain adapter ID, chat ID, channel type, and timestamps from inbound messages. A new API endpoint aggregates this data per adapter.

## Consequences

### Positive

- No new storage mechanism needed — reuses existing trace infrastructure
- Data is always accurate to what actually flowed through the system
- No external API calls to Telegram/etc. to discover chats
- Automatically includes chats from all channel types

### Negative

- Chat list is limited to what has been observed (new/unseen chats won't appear)
- Performance depends on trace store size — may need pagination or limits
- If traces are pruned/rotated, historical chat data is lost
