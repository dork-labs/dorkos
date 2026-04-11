---
number: 224
title: User-Facing "Channels" Vocabulary Over "Relay Adapters"
status: proposed
created: 2026-04-04
spec: channels-and-agent-adapters
superseded-by: null
---

# 224. User-Facing "Channels" Vocabulary Over "Relay Adapters"

## Status

Proposed

## Context

DorkOS uses "Relay Adapters" internally and in the UI to describe external messaging integrations (Telegram, Slack, Webhook). The industry standard term is "Channels" — used by Slack, Twilio, Intercom, and most agent/chatbot platforms. Users searching for "connect agent to Telegram" don't look for "Relay Adapters." Additionally, "Agent Adapters" (runtime backends like Claude Code) are a distinct concept that could be confused with "Relay Adapters."

## Decision

Adopt "Channels" as the user-facing term for all relay adapter integrations (Telegram, Slack, Webhook, etc.). Keep "Agent Adapters" as the term for runtime backends (Claude Code, future runtimes). Internal code (`RelayAdapter`, `AdapterConfig`, `BindingStore`, etc.) remains unchanged — this is a UI vocabulary change, not a code refactor.

## Consequences

### Positive

- Aligns with industry conventions — users immediately understand what "Channels" means
- Cleanly separates two concepts: Channels (how users reach agents) vs Agent Adapters (what powers agents)
- Eliminates the "Connections" naming collision between Agent Dialog and Relay Panel

### Negative

- Internal code still uses "adapter" terminology, creating a vocabulary gap between UI and code
- Contributors need to mentally map "Channel" (UI) ↔ "Adapter" (code) when working across layers
- Existing documentation and research artifacts reference "Relay Adapters"
