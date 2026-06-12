---
number: 153
title: Move Inference Status Display Outside the Scroll Container
status: accepted
created: 2026-03-20
spec: unified-status-strip
superseded-by: null
---

# 153. Move Inference Status Display Outside the Scroll Container

## Status

Accepted

## Context

The InferenceIndicator is currently positioned inside the MessageList virtualizer as an absolutely-positioned element below all virtual items. This means it scrolls with content and becomes invisible when the user scrolls up during a long streaming response. The SystemStatusZone, by contrast, is positioned between MessageList and the chat input and is always visible. Prior research (system-status-compact-boundary spec, research/20260316) confirmed that status information belongs outside the scroll container.

## Decision

Position the unified ChatStatusStrip between MessageList and the chat input, outside the scroll container, matching the current SystemStatusZone placement. This makes the status zone always visible regardless of scroll position. The MessageList is simplified by removing 7 inference-related props that were previously threaded through solely to reach the InferenceIndicator.

## Consequences

### Positive

- Status is always visible — users can see streaming progress even when scrolled up reading earlier messages
- MessageList interface simplified by 7 props, reducing coupling
- Eliminates prop-threading pattern where ChatPanel passed inference state through MessageList as a pass-through
- Consistent with the Slack typing indicator pattern (fixed zone between thread and input)

### Negative

- The status strip no longer "follows" the latest message spatially — there is a visual gap between the last message and the status zone when scrolled to bottom
- The strip occupies vertical space between messages and input that was previously shared with SystemStatusZone alone
