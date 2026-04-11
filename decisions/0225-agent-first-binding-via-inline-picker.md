---
number: 225
title: Agent-First Binding Management via Inline Channel Picker
status: proposed
created: 2026-04-04
spec: channels-and-agent-adapters
superseded-by: null
---

# 225. Agent-First Binding Management via Inline Channel Picker

## Status

Proposed

## Context

Binding management (connecting agents to channels like Telegram/Slack) was only available in the global Relay Panel — an adapter-centric view. Users had to leave the Agent Dialog, navigate to the Relay Panel, find the right adapter, and create a binding there. This required 3+ context switches per agent. The question was how deep inline binding management should go in the Agent Dialog: full inline editor, create/remove only, or create/remove with edit link.

## Decision

Add a Channels tab to the Agent Dialog with a create/remove + edit-link pattern. A channel picker popover lists configured channels with status. Selecting one creates a binding with sensible defaults (per-chat session strategy, all permissions enabled). Users click "Edit" to open the existing `BindingDialog` for advanced configuration (session strategy, permissions, chatId, channelType). This keeps the Agent Dialog lightweight while enabling the full agent-first workflow.

When no channels exist system-wide, the Agent Dialog shows a "Set Up a Channel" button that navigates to Settings → Channels (closing the Agent Dialog) rather than opening a nested wizard dialog.

## Consequences

### Positive

- Users can bind agents to channels without leaving the agent context
- Create-with-defaults pattern eliminates the need to understand advanced config upfront
- Reuses existing `BindingDialog` — no duplicate editing UI to maintain
- Navigation to Settings for channel setup is discoverable and consistent

### Negative

- "Edit" opens a separate dialog — not fully inline (trade-off for simplicity)
- Navigation to Settings for new channel setup loses agent context (user must return)
- The channel picker needs adapter status data, adding a dependency on `useAdapterCatalog`
