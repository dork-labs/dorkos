---
number: 98
title: Semantic Status Tokens for Tool State Colors
status: proposed
created: 2026-03-09
spec: chat-message-theming
superseded-by: null
---

# 98. Semantic Status Tokens for Tool State Colors

## Status

Proposed

## Context

Tool call status colors (running=blue, complete=green, error=red) and tool approval state colors (pending=amber, approved=emerald, denied=red) are hardcoded as Tailwind utility classes throughout `ToolCallCard.tsx` and `ToolApproval.tsx`. Each status has 3-4 color variants (bg, fg, border) spread across multiple components. Changing a status color requires finding and updating every instance. Dark mode overrides are inline (`dark:text-emerald-400`).

## Decision

Introduce semantic CSS custom properties (`--status-success`, `--status-error`, `--status-warning`, `--status-info`, `--status-pending`) with bg/fg/border sub-tokens for each status. Define light and dark values in `:root`/`.dark`. Register in `@theme inline` for Tailwind utility generation. All hardcoded status colors in message components are replaced with these tokens.

## Consequences

### Positive

- Status colors changeable from a single location (index.css)
- Dark mode handled automatically via `.dark` block
- Obsidian theme bridge maps status tokens alongside existing color tokens
- Reusable beyond chat — any component can use `text-status-success` etc.

### Negative

- More CSS custom properties to maintain (~20 new tokens)
- Slightly more indirection when debugging colors (must trace token to value)
