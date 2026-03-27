---
number: 137
title: Unified Input Zone for Interactive Cards
status: proposed
created: 2026-03-17
spec: interactive-card-focus-navigation
superseded-by: null
---

# 0137. Unified Input Zone for Interactive Cards

## Status

Proposed

## Context

DorkOS renders interactive cards (tool approvals and question prompts) inline in the chat message stream. These cards require user action before the agent can proceed. The current approach creates a dual-focus problem: the user's attention is split between the interactive card in the message stream and the chat input area at the bottom. Keyboard shortcuts require a global document listener with complex routing logic to determine which element should receive keystrokes. This pattern doesn't scale well and creates a fragmented interaction experience.

Claude Code Desktop solves this by rendering interactive elements in the input zone rather than inline in the message stream. The message stream becomes read-only history; the input zone is the single interaction surface.

## Decision

Relocate interactive cards (ToolApproval, QuestionPrompt) from the message stream into the ChatInputContainer. When the agent requires user input, the input zone transforms — replacing the text input, file chips, queue panel, and autocomplete palettes with the interactive card UI. The message stream shows only compact pending indicators during interaction and compact result rows after resolution. The user's draft text is preserved invisibly and restored when the interaction completes.

The input zone becomes a "conversation surface" that adapts to what the conversation requires: sometimes it's a text input, sometimes it's an approval card, sometimes it's a question form.

## Consequences

### Positive

- Eliminates the dual-focus problem entirely — one interaction point
- Simplifies keyboard architecture — no global document listener routing needed
- Natural attention flow: eyes read messages top-down, hands interact at the bottom
- Proven UX pattern (Claude Code Desktop)
- Message stream becomes simpler (compact rows instead of full interactive cards)

### Negative

- Significant refactor of how interactive cards are rendered and composed
- Transition animation complexity (crossfade between normal and interactive modes)
- Must handle edge case of user typing when interactive card appears (draft preservation)
- Queue management for multiple pending interactions
- ToolApproval countdown timer may reset if component re-mounts in the input zone
