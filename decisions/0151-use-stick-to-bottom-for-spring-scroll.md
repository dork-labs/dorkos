---
number: 151
title: Replace Custom Scroll Logic with use-stick-to-bottom for Spring-Based Streaming Scroll
status: accepted
created: 2026-03-20
spec: chat-streaming-motion
superseded-by: null
---

# 151. Replace Custom Scroll Logic with use-stick-to-bottom for Spring-Based Streaming Scroll

## Status

Accepted

## Context

MessageList.tsx contains sophisticated custom scroll logic: a ResizeObserver primary mechanism, message-count-change fallback effect, IntersectionObserver for Obsidian visibility, and user-intent detection via wheel/touch events with 150ms debounce (ADR-0092). Despite this, auto-scroll during streaming sets `scrollTop` directly, causing micro-jumps as content grows. The browser's native `overflow-anchor` can also conflict with programmatic scroll. `use-stick-to-bottom` (StackBlitz Labs) is the de-facto standard for streaming chat scroll, used by shadcn/ui AI Conversation and prompt-kit.

## Decision

Replace the custom ResizeObserver + RAF + message-count-change scroll logic with `use-stick-to-bottom`, which provides velocity-based spring interpolation for scroll position. Retain the Obsidian IntersectionObserver visibility detection separately (the library doesn't handle this edge case). Add `overflow-anchor: none` to the scroll container CSS. Map the library's `isAtBottom` state to `useScrollOverlay` via a boolean approximation (`distanceFromBottom: isAtBottom ? 0 : 200`).

## Consequences

### Positive

- Spring-based scroll creates visibly smoother streaming experience (no micro-jumps)
- Built-in user-intent detection (wheel/touch detach/reattach) replaces custom implementation
- Reduces custom scroll code in MessageList.tsx significantly
- Battle-tested library used by major AI chat products
- `overflow-anchor: none` eliminates browser scroll anchoring conflicts

### Negative

- New dependency (~3KB)
- Obsidian IntersectionObserver must be maintained separately
- Integration with TanStack Virtual's absolute positioning needs verification during implementation
- `distanceFromBottom` is approximated rather than computed precisely (acceptable since only `isAtBottom` is consumed downstream)
