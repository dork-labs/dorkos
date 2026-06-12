---
number: 92
title: Gate Auto-Scroll Disengagement Behind User Scroll Intent via wheel/touchstart
status: superseded
created: 2026-03-08
spec: fix-chat-streaming-history-consistency
superseded-by: 151
---

# 0092. Gate Auto-Scroll Disengagement Behind User Scroll Intent via wheel/touchstart

## Status

Superseded by ADR-0151 (Replace Custom Scroll Logic with use-stick-to-bottom for Spring-Based Streaming Scroll) — the custom wheel/touchstart scroll-intent tracking was replaced by the use-stick-to-bottom library.

## Context

The DorkOS chat `MessageList` component uses a `scroll` event listener with a 200px `distanceFromBottom` threshold to determine whether the user is at the bottom of the chat. When the user is at the bottom (`isAtBottomRef.current === true`), new messages auto-scroll into view. When `scroll` fires with `distanceFromBottom > 200`, `isAtBottomRef` is set to `false` and auto-scroll disengages.

TanStack Virtual's `measureElement` ResizeObserver fires frequently during long message streaming, causing `scrollHeight` to temporarily fluctuate. This triggers `scroll` events from layout reflow — not user input — which spuriously flip `isAtBottomRef` to `false`, disengaging auto-scroll without any user action.

Alternatives considered: (A) Increase the 200px threshold — insufficient, any fixed value can be exceeded by extreme reflow; (B) IntersectionObserver sentinel div — immune to reflow but requires structural JSX change and has a one-frame async delay; (C) `isUserScrollingRef` + `wheel`/`touchstart` — selected.

## Decision

We track user scroll intent using an `isUserScrollingRef` boolean flag. Passive `wheel` and `touchstart` event listeners on the scroll container set this flag to `true` for 150ms via a debounced `setTimeout`. In `handleScroll`, `isAtBottomRef` is only allowed to become `false` when `isUserScrollingRef.current === true`.

Browser-native `wheel` and `touchstart` events cannot fire from programmatic `scrollTop` assignment or layout reflow — only from physical user input. This precisely isolates intentional user scroll-up from virtualizer measurement side effects.

## Consequences

### Positive

- Eliminates false auto-scroll disengagement caused by TanStack Virtual measurement reflows during streaming
- Semantically correct: auto-scroll only disengages when the user actually scrolls up
- Two lightweight passive event listeners with negligible overhead
- Community-validated pattern (used in autoscroll-react and similar libraries)

### Negative

- The 150ms intent window is slightly imprecise — a user who stops scrolling and immediately resumes within 150ms may have auto-scroll re-engage momentarily. In practice this is imperceptible.
- Two additional event listeners per mounted `MessageList` instance (low overhead)
- jsdom does not model `scrollHeight`/`scrollTop` dynamically, making unit tests for this behavior require `Object.defineProperty` workarounds
