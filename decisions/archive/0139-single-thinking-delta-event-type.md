---
number: 139
title: Single thinking_delta StreamEvent Type Without Separate Start/End Events
status: draft
created: 2026-03-16
spec: extended-thinking-visibility
superseded-by: null
---

# 139. Single thinking_delta StreamEvent Type Without Separate Start/End Events

## Status

Draft (auto-extracted from spec: extended-thinking-visibility)

## Context

DorkOS needs to surface Claude's extended thinking blocks through the SSE streaming pipeline. The SDK emits three distinct events for thinking: `content_block_start(thinking)`, `content_block_delta(thinking_delta)`, and `content_block_stop`. The question is whether DorkOS should mirror this three-event model or simplify it.

The existing `text_delta` pattern uses a single event type — no `text_start` or `text_end` events exist. The stream handler detects phase transitions implicitly (first text_delta creates a new TextPart; tool_call_start signals text is complete). ADR-0136 (rate_limit) and ADR-0137 (subagent lifecycle) established the pattern for adding new StreamEvent types.

## Decision

Use a single `thinking_delta` StreamEvent type. The server mapper handles `content_block_start(thinking)` by setting `toolState.inThinking = true` (no event emitted), yields `thinking_delta` events for each `content_block_delta(thinking_delta)`, and resets the flag on `content_block_stop` (no event emitted). The client detects the thinking-to-text transition implicitly when the first `text_delta` arrives after a thinking phase.

## Consequences

### Positive

- Matches the established `text_delta` pattern — no new event type categories to learn
- Simpler client-side stream handler — one new case instead of three
- Fewer SSE events over the wire (no empty start/stop signals)
- Consistent with the project convention of implicit phase detection

### Negative

- No explicit signal that thinking has ended — the client must infer this from the arrival of the first `text_delta`, which adds coupling between the thinking and text phases
- If the SDK ever emits thinking blocks without a following text block, the thinking part would remain in `isStreaming: true` state until the `done` event
