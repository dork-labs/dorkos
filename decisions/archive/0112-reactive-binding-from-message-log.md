---
number: 112
title: Reactive Binding Creation from Message Log
status: archived
created: 2026-03-11
spec: adapter-binding-ux-overhaul
superseded-by: null
---

# 112. Reactive Binding Creation from Message Log

## Status

Draft (auto-extracted from spec: adapter-binding-ux-overhaul)

## Context

Users need to create chat-specific bindings (routing rules with chatId/channelType). They could enter chat IDs manually in a form, or create bindings reactively from actual message data. Research found that Gmail's "filter from message" pattern and Slack's "default to current conversation" pattern are industry best practices for routing rule creation.

## Decision

Provide two entry points for chat-specific binding creation: (1) a chatId picker in the BindingDialog populated from observed chats, and (2) a "Route to Agent" action on conversation rows in the message log that pre-fills the binding dialog with the conversation's chat metadata.

## Consequences

### Positive

- Users create routing rules from real data, not guessing chat IDs
- The "Route to Agent" flow is contextual — user sees the messages and decides where to route them
- Both proactive (dialog picker) and reactive (message log) workflows are supported
- Reduces user error from manual ID entry

### Negative

- Requires a new observed chats API endpoint to populate the picker
- Two entry points to the same action may confuse some users
- "Route to Agent" adds UI complexity to conversation rows
