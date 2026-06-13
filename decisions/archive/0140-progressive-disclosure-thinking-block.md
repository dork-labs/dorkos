---
number: 140
title: Progressive Disclosure Collapsible Block for Extended Thinking UI
status: draft
created: 2026-03-16
spec: extended-thinking-visibility
superseded-by: null
---

# 140. Progressive Disclosure Collapsible Block for Extended Thinking UI

## Status

Draft (auto-extracted from spec: extended-thinking-visibility)

## Context

DorkOS needs a UI pattern to display Claude's extended thinking content. Thinking blocks can range from 100 to 10,000+ tokens and always precede the response text. The UI must balance transparency (showing the reasoning) with calm tech principles (not overwhelming the user with noise).

Research found industry convergence on progressive disclosure: Claude.ai, ChatGPT, Perplexity, and v0 all use variations of a collapsible block that opens during streaming and collapses when the response begins. Alternative approaches considered: inline dimmed text (rejected — violates "less but better"), side panel (rejected for v1 — too complex, context-switching cost).

## Decision

Use a four-state progressive disclosure collapsible block: (1) streaming — open block with breathing "Thinking..." label and live text, (2) collapsing — animated height collapse when first text_delta arrives, (3) collapsed — "Thought for Xs" chip with chevron expand/collapse, (4) expanded — full content visible with max-h-64 overflow-y-auto cap. The block follows the visual pattern established by SubagentBlock.tsx (bg-muted/50, AnimatePresence, motion.div transitions).

## Consequences

### Positive

- Matches Claude.ai reference implementation — familiar to users who have seen thinking elsewhere
- Honest by design — collapsed chip always present, nothing silently discarded
- Calm tech aligned — open when relevant (during streaming), collapsed when the answer is the focus
- Follows established SubagentBlock pattern — consistent codebase, less new code

### Negative

- Four visual states require careful transition management and testing
- Auto-collapse on streaming-to-text transition adds complexity to the stream handler (must coordinate isStreaming flag across ThinkingPart)
- Long thinking blocks (10,000+ tokens) may need ref-based buffering for performance, adding implementation complexity
