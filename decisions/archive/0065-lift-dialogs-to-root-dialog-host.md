---
number: 65
title: Lift Dialogs to Root-Level DialogHost
status: proposed
created: 2026-03-03
spec: shadcn-sidebar-redesign
superseded-by: null
---

# 65. Lift Dialogs to Root-Level DialogHost

## Status

Proposed

## Context

SessionSidebar.tsx renders 7 dialog instances (Settings, Pulse, Relay, Mesh, DirectoryPicker, AgentDialog, OnboardingFlow) inside the sidebar component. On mobile, closing the Shadcn Sheet unmounts the sidebar, which destroys any open dialogs mid-interaction. The open/close state for all these dialogs already lives in the Zustand store (`app-store.ts`) — only the JSX rendering is co-located with the sidebar. This violates the principle that dialogs are global UI, not sidebar-scoped.

## Decision

Extract all dialog rendering to a `DialogHost` component rendered at the App.tsx root level, outside `SidebarProvider`. DialogHost reads open/close state from the Zustand store (no new state management patterns needed). Two new transient state entries (`agentDialogOpen`, `onboardingStep`) are added to the Zustand store to replace local state that was previously in SessionSidebar.

## Consequences

### Positive

- Dialogs survive sidebar open/close cycles and mobile Sheet unmounts
- SessionSidebar drops from 392 to ~150 lines (single responsibility)
- Consistent with how CommandPaletteDialog and Toaster are already rendered (outside main layout)
- No new state management patterns — Zustand already has all the state

### Negative

- DialogHost component has many imports (7 dialog components + entity hooks for DirectoryPicker)
- Zustand store grows slightly (2 new transient boolean/nullable fields)
- Some dialog context (e.g., `selectedCwd` for DirectoryPicker, `resolvedAgents`) must be fetched in DialogHost instead of being available from SessionSidebar's existing hooks
