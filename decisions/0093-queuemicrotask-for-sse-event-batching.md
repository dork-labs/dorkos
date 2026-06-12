---
number: 93
title: Defer tool_result Re-Render via queueMicrotask to Batch Adjacent SSE Events
status: deprecated
created: 2026-03-08
spec: fix-chat-streaming-history-consistency
superseded-by: null
---

# 0093. Defer tool_result Re-Render via queueMicrotask to Batch Adjacent SSE Events

## Status

Deprecated — the queueMicrotask batching layer was deleted along with the legacy client stream handler when spec chat-stream-reconnection replaced the streaming architecture (ADR-0264); no equivalent batching tactic exists in the new session-stream store.

## Context

The DorkOS streaming event handler (`stream-event-handler.ts`) processes SSE events synchronously in a `switch` statement. For tool call sequences, the SDK emits events in this order: `tool_call_end → tool_result → text_delta("Done")`. The `tool_result` handler sets `existing.result` on the tool call part and immediately calls `updateAssistantMessage()`, triggering a React render before `text_delta("Done")` arrives.

This intermediate render produces an orphaned `"Done"` text element — a React text part appended by the next `text_delta` event — which renders as a floating plain-text string between the collapsed tool card and the following response text. The history view has no intermediate renders (transcript-parser assembles state atomically), creating a streaming vs. history visual divergence.

Alternatives considered: (A) Filter tool_result blocks in `MessageItem` render — fragile, targets a `text` part type not a `tool_call` part; (B) ToolCallCard absorption — inapplicable, orphan is a separate text part; (C) `queueMicrotask` deferral — selected (Vercel AI SDK v5 community pattern for transient parts).

## Decision

In the `tool_result` case of the streaming event handler, `updateAssistantMessage(assistantId)` is wrapped in `queueMicrotask(() => updateAssistantMessage(assistantId))`. This defers the React state update by one microtask, allowing the immediately-following `text_delta("Done")` SSE event to be processed synchronously in the current event loop turn first. By the time `queueMicrotask` fires, `currentPartsRef.current` already contains the `"Done"` text part, producing a unified render that matches the history view. If SSE chunks are split across network ticks (making `queueMicrotask` insufficient), the fallback is `setTimeout(fn, 0)`.

## Consequences

### Positive

- Eliminates orphaned "Done" text during streaming of tool call sequences
- One-line, surgical change; no other event cases are affected
- Aligns streaming behavior with history view (both render atomically)
- Matches Vercel AI SDK v5 "transient parts" pattern — established precedent

### Negative

- Relies on `text_delta("Done")` arriving in the same event loop turn as `tool_result`. If SSE delivery splits these events across network chunks, the `queueMicrotask` will fire before `text_delta` and the issue may persist (requiring `setTimeout(0)` upgrade)
- Slightly delays the `tool_result` render by one microtask — imperceptible to users
