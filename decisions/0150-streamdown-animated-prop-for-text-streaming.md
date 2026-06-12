---
number: 150
title: Use Streamdown's Built-In animated Prop for Per-Word Text Streaming Animation
status: accepted
created: 2026-03-20
spec: chat-streaming-motion
superseded-by: null
---

# 150. Use Streamdown's Built-In animated Prop for Per-Word Text Streaming Animation

## Status

Accepted

## Context

The DorkOS chat streaming experience lacks visual polish — text chunks appear abruptly in the DOM with no transition effect. Research into production AI chat UIs found that Perplexity uses per-word blur-in animation to create a noticeably more premium feel, while ChatGPT and Claude.ai rely solely on natural token cadence. We evaluated four approaches: streamdown's built-in `animated` prop, FlowToken library, a custom rehype plugin, and no animation.

## Decision

Use streamdown's built-in `animated` prop (confirmed in v2.4.0) with `blurIn` preset at word-level granularity. Streamdown's rehype plugin walks the HTML AST post-markdown-rendering and wraps text nodes in `<span data-sd-animate>` elements — code blocks, `<pre>`, `<svg>`, and `<math>` are never split. When `isAnimating` is `false`, spans are excluded entirely, producing zero residual DOM overhead on completed messages. This requires importing `streamdown/styles.css` for the `@keyframes` definitions.

## Consequences

### Positive

- Zero new dependencies (streamdown already installed at ^2.4.0)
- Three built-in presets (`fadeIn`, `blurIn`, `slideUp`) cover all desired effects
- Animation spans are automatically excluded on completed messages (no performance debt)
- Works correctly with markdown rendering — code blocks and special elements are preserved
- Swappable via `TextEffectConfig` architecture for easy future iteration

### Negative

- Word-level splitting adds ~180 spans per 1000 characters during active streaming
- Requires `streamdown/styles.css` CSS import (additional file to load)
- Animation behavior is coupled to streamdown's implementation — changes in future streamdown versions could affect the experience
