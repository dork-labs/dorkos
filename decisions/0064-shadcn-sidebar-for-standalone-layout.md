---
number: 64
title: Use Shadcn Sidebar for Standalone Layout
status: proposed
created: 2026-03-03
spec: shadcn-sidebar-redesign
superseded-by: null
---

# 64. Use Shadcn Sidebar for Standalone Layout

## Status

Proposed

## Context

DorkOS's standalone sidebar uses ~200 lines of custom motion.dev code across App.tsx and SessionSidebar.tsx for mobile overlay (AnimatePresence + backdrop + slide) and desktop push (animated width) patterns. This custom code duplicates functionality that Shadcn's Sidebar component provides out of the box, including mobile Sheet behavior (backdrop, swipe-to-close, auto-close-on-nav), desktop push layout, keyboard shortcuts (Cmd+B), and ARIA accessibility. The embedded mode (Obsidian plugin) has different DOM constraints and cannot use SidebarProvider.

## Decision

Replace the custom motion.dev sidebar layout with Shadcn's `SidebarProvider` + `Sidebar` + `SidebarInset` for the standalone web path only. Keep the embedded mode's custom overlay implementation unchanged. Use controlled mode (`open`/`onOpenChange`) to bridge Shadcn state to the existing Zustand store.

## Consequences

### Positive

- Deletes ~200 lines of custom sidebar/overlay/push animation code
- Gets free mobile Sheet behavior (backdrop, swipe-to-close, auto-close-on-nav)
- Built-in Cmd+B keyboard shortcut replaces custom handler
- ARIA accessibility handled by the component
- Future `collapsible="icon"` rail mode available without additional work
- SidebarRail provides hover-expand at sidebar edge

### Negative

- Requires `--sidebar-*` CSS variables in index.css
- Two separate sidebar implementations: Shadcn for standalone, custom for embedded
- SidebarProvider wraps most of App.tsx, changing DOM structure
- Mobile and desktop sidebar state are separated (desktop in Zustand, mobile internal to Shadcn)
