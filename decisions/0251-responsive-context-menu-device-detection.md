---
number: 251
title: Responsive Context Menu via Device Detection
status: accepted
created: 2026-04-13
spec: session-rename-fork
superseded-by: null
---

# 251. Responsive Context Menu via Device Detection

## Status

Accepted

## Context

The SessionContextMenu currently uses Radix ContextMenu which only supports desktop right-click. On mobile, Radix's native long-press opens a floating menu at the pointer position, which clips on small screens. A better mobile experience is a full-width bottom drawer. Three approaches were evaluated: (A) single component with device detection, (B) composition with a shared items array, and (C) CSS media query hide/show.

## Decision

Use Approach A — a single `ResponsiveContextMenu` component that reads `useIsMobile()` and renders either a Radix ContextMenu (desktop) or a Vaul Drawer with long-press trigger (mobile). This mirrors the existing `ResponsiveDropdownMenu` and `ResponsiveDialog` patterns already established in the codebase at `layers/shared/ui/`.

## Consequences

### Positive

- Matches the established responsive primitive pattern in the codebase (consistency)
- Single API surface for consumers — callers don't need to know about device type
- Mobile users get a full-width bottom sheet with proper touch targets (44px min)
- JSX children are shared between desktop and mobile paths (no duplication)

### Negative

- Requires a `useLongPress` hook to trigger the drawer on mobile (small but new code)
- Must suppress Radix's native long-press behavior on mobile to avoid double-trigger
- Two rendering paths means two code paths to test
