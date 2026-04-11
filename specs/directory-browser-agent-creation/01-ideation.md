---
slug: directory-browser-agent-creation
number: 234
created: 2026-04-11
status: ideation
---

# Directory Browser for Agent Creation

**Slug:** directory-browser-agent-creation
**Author:** Claude Code
**Date:** 2026-04-11
**Branch:** preflight/directory-browser-agent-creation

---

## 1) Intent & Assumptions

- **Task brief:** The agent creation dialog currently uses a plain text input for an optional directory override. Replace or augment this with a visual directory browser so users can navigate and select a directory rather than typing a path from memory.
- **Assumptions:**
  - The project already has a reusable `DirectoryPicker` component (confirmed)
  - The existing `browseDirectory` and `createDirectory` transport/API layer can be reused without changes
  - Both the "New Agent" and "From Template" tabs share the same directory input and should both get the browser
- **Out of scope:**
  - Building a new directory browser component from scratch
  - Changes to the server-side directory browsing API
  - Native OS file dialog integration (Electron `dialog.showOpenDialog`)
  - Inline tree view embedded directly in the creation dialog

## 2) Pre-reading Log

- `apps/client/src/layers/shared/ui/DirectoryPicker.tsx`: Full-featured directory browser modal (393 lines) with browse/recent views, folder creation, breadcrumbs, and show/hide hidden folders toggle
- `apps/client/src/layers/shared/ui/path-breadcrumb.tsx`: Breadcrumb navigation component used by DirectoryPicker (74 lines)
- `apps/client/src/layers/features/agent-creation/ui/CreateAgentDialog.tsx`: Agent creation dialog with tabbed interface (237 lines) — currently uses a collapsible text input for directory override
- `apps/client/src/layers/shared/model/agent-creation-store.ts`: Zustand store managing `isOpen` and `initialTab` (18 lines)
- `apps/client/src/layers/shared/lib/transport/system-methods.ts`: Transport layer with `browseDirectory()` and `createDirectory()` methods (288 lines)
- `apps/server/src/routes/directory.ts`: Server endpoints for directory browsing with boundary validation (126 lines)
- `apps/client/src/layers/entities/discovery/ui/ScanRootInput.tsx`: Existing pattern of text input + browse button opening DirectoryPicker
- `apps/client/src/layers/widgets/app-layout/model/wrappers/DirectoryPickerWrapper.tsx`: Dialog contribution system integration for DirectoryPicker
- `apps/client/src/layers/features/onboarding/ui/NoAgentsFound.tsx`: Another consumer of DirectoryPicker
- `apps/client/src/layers/features/mesh/ui/RegisterAgentDialog.tsx`: Another consumer of DirectoryPicker

## 3) Codebase Map

**Primary Components/Modules:**

- `layers/shared/ui/DirectoryPicker.tsx` — Reusable directory browser modal with browse/recent views, folder creation, breadcrumbs
- `layers/shared/ui/path-breadcrumb.tsx` — Breadcrumb navigation for directory paths
- `layers/features/agent-creation/ui/CreateAgentDialog.tsx` — Agent creation form with three tabs (New Agent, From Template, Import)
- `layers/shared/model/agent-creation-store.ts` — Zustand store for dialog open state and initial tab
- `layers/entities/discovery/ui/ScanRootInput.tsx` — Reference pattern: text input + folder icon button that opens DirectoryPicker

**Shared Dependencies:**

- `@tanstack/react-query` — Query fetching and cache management
- `lucide-react` — Icons (`Folder`, `FolderOpen`, `Check`, `X`, etc.)
- `sonner` — Toast notifications
- `@dorkos/shared/validation` — `validateAgentName`, `AGENT_NAME_REGEX`
- `@dorkos/shared/transport` — Transport types and methods
- Utilities: `shortenHomePath`, `formatRelativeTime`, `resolveAgentVisual`

**Data Flow:**

1. DirectoryPicker opens (controlled by parent `open` state)
2. Fetches directory listing via `transport.browseDirectory()` (GET `/api/directory`)
3. Server validates against boundary, returns directory entries
4. User navigates/selects directory -> `onSelect(path)` callback fires
5. Parent component writes to `directoryOverride` state
6. Form submission passes `{ name, directory: directoryOverride }` to `transport.createAgent()`

**Feature Flags/Config:** None identified.

**Potential Blast Radius:**

- Direct: `CreateAgentDialog.tsx` (add browse button + DirectoryPicker)
- Direct: `CreateAgentDialog.test.tsx` (add test for browse button)
- Indirect: None — DirectoryPicker is used as-is, no changes needed
- Transport/Server: None — `browseDirectory` and `createDirectory` already implemented

## 4) Root Cause Analysis

N/A — not a bug fix.

## 5) Research

### Potential Solutions

**1. Text Input + "Browse" Icon Button (Hybrid) -- Recommended**

Keep the existing text input for power users who want to paste/type paths. Add a `FolderOpen` icon button next to it that opens the existing `DirectoryPicker` modal. Picker's `onSelect` writes to `directoryOverride`.

- Pros:
  - Reuses all existing tested infrastructure (zero new components)
  - Consistent with `ScanRootInput` pattern already used elsewhere in the app
  - Does not increase dialog height — picker opens as a separate modal
  - Power users can still type/paste raw paths
  - Minimal change surface (~15 lines in CreateAgentDialog)
- Cons:
  - Two-step interaction (click icon -> modal -> navigate -> select)
  - Modal-on-modal layering (Dialog opens ResponsiveDialog) — works in Radix/shadcn but worth testing
- Complexity: Low
- Maintenance: None beyond existing DirectoryPicker tests

**2. Replace Text Input with Picker-Only (No Text Field)**

Remove the text input entirely; directory is only settable via the picker. Show resolved path as read-only text.

- Pros: Cleanest UX, no typo risk, always shows a valid path
- Cons: Removes power-user copy-paste path; breaks accessibility for users who know their path
- Complexity: Low
- Maintenance: Low

**3. Inline Expandable Tree View (New Component)**

Build a new `DirectoryTree` component rendered inline within the dialog's collapsible section.

- Pros: Single-surface experience with no modal layering
- Cons: Significant height added to compact dialog; requires new component with lazy-load/virtualization; duplicates DirectoryPicker logic; WAI-ARIA treeitem keyboard accessibility complexity
- Complexity: High
- Maintenance: High

**4. Replace Text Input with ScanRootInput Chip Component**

Reuse the chip/tag pattern from `ScanRootInput`.

- Pros: Reuses an existing pattern
- Cons: Chip/multi-tag UX is semantically wrong for a single directory value; visually heavy
- Complexity: Low
- Maintenance: Medium

### Security Considerations

- `transport.browseDirectory` and `transport.createDirectory` already sanitize inputs server-side — no new attack surface
- Directory path passed to `createAgent` is validated on the server regardless of client-side input method

### Performance Considerations

- DirectoryPicker uses React Query with `staleTime: 30_000` and `placeholderData` — navigation is instant after first fetch
- Modal approach means filesystem queries only fire when user opens the picker, not on dialog mount
- Flat-list-per-level design (not recursive tree) is implicit lazy loading — each level fetched on navigation

### Recommendation

**Solution 1 (Hybrid: Text Input + Browse Button)** is the clear choice:

1. The `DirectoryPicker` component is already built, tested (30+ tests), and exported from shared/ui
2. The pattern is already established by `ScanRootInput` — this creates consistency
3. The change is ~15 lines in `CreateAgentDialog.tsx` with no new components
4. FSD layer compliance is clean: `features/agent-creation` importing from `shared/ui` is explicitly allowed

## 6) Decisions

| #   | Decision                      | Choice                                              | Rationale                                                                                                 |
| --- | ----------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | Keep text input or replace?   | Keep both (hybrid)                                  | Power users need paste/type; browse button adds visual navigation. Consistent with ScanRootInput pattern. |
| 2   | Build new component or reuse? | Reuse DirectoryPicker as-is                         | Already exists, tested, used in 4 other places. Zero modifications needed.                                |
| 3   | Inline tree or modal?         | Modal (existing DirectoryPicker)                    | Keeps dialog compact; avoids building new component; lazy-loads on open.                                  |
| 4   | Pass initialPath?             | Yes, pass `directoryOverride \|\| defaultDirectory` | Picker opens at the relevant location instead of root.                                                    |
