---
number: 97
title: Adopt tailwind-variants for Multi-Slot Feature Components
status: proposed
created: 2026-03-09
spec: chat-message-theming
superseded-by: null
---

# 97. Adopt tailwind-variants for Multi-Slot Feature Components

## Status

Proposed

## Context

The chat `MessageItem` component has 5 visually distinct regions (root, leading, content, timestamp, divider) that all respond to the same variant axes (role, position, density). CVA, used for shadcn primitives, only handles single-element variants — styling multiple slots from one variant call is not supported. This forces inline ternary expressions for each element, making the variant system implicit and scattered.

## Decision

Add `tailwind-variants` (~3.5KB min+gzip) for multi-slot feature-level components like `MessageItem`. CVA remains for single-element shadcn primitives. The two libraries coexist — both output class strings. TV is used when a component has multiple DOM elements that need to respond to the same variant axes simultaneously.

## Consequences

### Positive

- One `tv()` call drives all slots; variant changes flow to all elements simultaneously
- Compound variants can express complex state combinations declaratively
- Built-in Tailwind class conflict resolution via `twMerge` integration
- Consistent with industry patterns (Nuxt UI uses the same approach)

### Negative

- New dependency added to the client bundle
- Team needs to learn the `tv()` API alongside `cva()`
- Two variant libraries in the same codebase may cause initial confusion about when to use which
