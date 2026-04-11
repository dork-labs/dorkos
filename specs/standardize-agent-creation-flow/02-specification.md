---
slug: standardize-agent-creation-flow
number: 232
created: 2026-04-11
status: specified
linear-issue: null
---

# Standardize Agent Creation Flow — Specification

## Overview

Redesign `CreateAgentDialog` into a unified three-tab dialog ("New Agent", "From Template", "Import") used by every entry point in the app. Fix two bugs where sidebar entry points open the wrong dialog. Delete built-in template code in favor of marketplace-only templates.

### Goals

1. **One dialog, everywhere**: Every "create/add agent" action opens the same unified dialog
2. **Three clear paths**: New Agent (from scratch), From Template (marketplace), Import (filesystem scan)
3. **Minimal creation**: Name + location is all that's required; personality deferred to post-creation settings
4. **Fix entry point bugs**: Dashboard sidebar and session sidebar currently open the editing dialog instead of creation
5. **Delete dead code**: Remove built-in template catalog in favor of marketplace templates

### Non-Goals

- Onboarding UI changes (keeps own flow, but should converge hooks in a follow-up)
- Server-side creation pipeline changes
- Agent settings/editing dialog changes
- CLI/MCP tool creation paths

## Technical Design

### Architecture: Three-Tab Creation Dialog

The existing `CreateAgentDialog` evolves into a tabbed dialog using the Shadcn `Tabs` component (Radix-based, already in `shared/ui/tabs.tsx`).

```
┌──────────────────────────────────────────────────────┐
│  Create Agent                                        │
│  Set up a new agent or import an existing project.   │
│                                                      │
│  ┌────────────┬──────────────┬───────────────────┐   │
│  │ New Agent  │ From Template│ Import            │   │
│  └────────────┴──────────────┴───────────────────┘   │
│                                                      │
│  [Tab-specific content — see below]                  │
│                                                      │
│                           [Cancel]  [Create Agent]   │
└──────────────────────────────────────────────────────┘
```

**Dialog sizing**: `sm:max-w-lg` (up from `sm:max-w-md`) to give the template grid and discovery results adequate space.

### Tab 1: New Agent

The default tab. Minimal form for creating an agent from scratch.

**Fields:**

- **Name** (text input, required, auto-focused) — validated via `validateAgentName()`
- **Location** (text input + Browse button) — defaults to `{defaultDirectory}/{name}`, auto-updates as name changes
- **Resolved path preview** (muted text below location input) — shows expanded absolute path

**Conflict detection** (stretch goal — can be deferred to follow-up):

- Debounced 300ms check of `{path}/.dork` existence via a new lightweight transport method
- States: "Will be created" (default) | "Existing project detected — import instead?" (with link to Import tab) | "Directory exists, no project" | "Invalid path" (prevents submit)

**Submit**: Calls `useCreateAgent.mutate({ name, directory })`. No template, no traits.

### Tab 2: From Template

Template picker showing marketplace agent templates, with custom GitHub URL in an Advanced section.

**Fields:**

- **Template picker grid** — marketplace agent packages via `useMarketplacePackages({ type: 'agent' })`. Compact cards: name + description. Click to select (toggle).
- **Advanced disclosure** (collapsed by default) — Custom GitHub URL text input
- **Name** (text input, required) — auto-fills from selected template name (editable)
- **Location** (text input + Browse) — same behavior as Tab 1

**Changes from current TemplatePicker:**

- Remove `useTemplateCatalog()` hook and built-in template tab entirely
- Remove category filter pills (no built-in categories to filter)
- Marketplace grid becomes the primary (and only) template display
- Custom GitHub URL moves inside a `Collapsible` labeled "Advanced"
- Grid selection and URL input remain mutually exclusive

**Submit**: Calls `useCreateAgent.mutate({ name, directory, template })` where `template` is the marketplace source URL or custom GitHub URL.

### Tab 3: Import

Reuses the existing `DiscoveryView` component as-is.

```tsx
<TabsContent value="import">
  <DiscoveryView />
</TabsContent>
```

`DiscoveryView` already renders correctly with `fullBleed={false}` (its default), producing `space-y-4 p-4` layout suitable for dialog embedding. It manages its own scan state, root paths, candidate list, bulk import, and error handling.

**Footer behavior**: When the Import tab is active, the dialog footer's "Create Agent" button is hidden (DiscoveryView has its own "Import Selected" / per-candidate action buttons). Only "Cancel" remains.

### State Management Changes

#### Extend `useAgentCreationStore`

Add an optional `initialTab` field so entry points can open the dialog pre-focused on a specific tab:

```ts
// shared/model/agent-creation-store.ts
type CreationTab = 'new' | 'template' | 'import';

interface AgentCreationState {
  isOpen: boolean;
  initialTab: CreationTab;
  open: (tab?: CreationTab) => void;
  close: () => void;
}
```

Default `initialTab` is `'new'`. The dialog reads `initialTab` on open and passes it as the `defaultValue` to the `<Tabs>` component. Reset to `'new'` on close.

#### Fix Entry Points

| Entry Point                              | Current (broken)                          | After (fixed)                                          |
| ---------------------------------------- | ----------------------------------------- | ------------------------------------------------------ |
| `AddAgentMenu.tsx` "Create agent"        | `setAgentDialogOpen(true)`                | `useAgentCreationStore.getState().open()`              |
| `AddAgentMenu.tsx` "Import project"      | `setPickerOpen(true)`                     | `useAgentCreationStore.getState().open('import')`      |
| `SidebarTabRow.tsx` + button             | `setAgentDialogOpen(true)`                | `useAgentCreationStore.getState().open()`              |
| `AgentsHeader.tsx` "New Agent"           | `useAgentCreationStore.open()`            | No change (already correct)                            |
| `AgentsHeader.tsx` "Search for Projects" | Opens separate dialog                     | Delete button; "New Agent" button opens unified dialog |
| Command palette "Create agent"           | `useAgentCreationStore.getState().open()` | No change (already correct)                            |

### Component Changes

#### `CreateAgentDialog.tsx` — Major Rewrite

- Add `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` from `shared/ui`
- Move name + location fields into Tab 1 content (duplicated in Tab 2 with template-specific behavior)
- Embed `DiscoveryView` in Tab 3
- Remove `TraitSliders` import and personality `Collapsible`
- Remove `traits` state, `personalityOpen` state, `playSliderTick` import
- Remove `template` and `templateOpen` state from the top-level form (template lives inside Tab 2)
- Track active tab to conditionally show/hide footer "Create" button (hidden on Import tab)
- Read `initialTab` from store for `<Tabs defaultValue={...}>`

#### `TemplatePicker.tsx` — Simplify

- Remove `useTemplateCatalog` import and built-in template tab
- Remove `CATEGORY_TABS` constant and category filter state
- Make marketplace grid the sole content (no inner tabs)
- Wrap custom GitHub URL input in a `Collapsible` labeled "Advanced"
- Keep the same `TemplatePickerProps` interface (`selectedTemplate`, `onSelect`)

#### `AgentsHeader.tsx` — Simplify

- Remove "Search for Projects" button and its `ResponsiveDialog`/`DiscoveryView` import
- Remove `discoveryOpen` state
- Keep single "New Agent" button that calls `useAgentCreationStore.open()`

#### `AddAgentMenu.tsx` — Fix Wiring

- Import `useAgentCreationStore` from `@/layers/shared/model` instead of using `useAppStore`
- "Create agent" → `useAgentCreationStore.getState().open()`
- "Import project" → `useAgentCreationStore.getState().open('import')`
- "Browse Dork Hub" → unchanged (navigates to `/marketplace`)
- Remove `setAgentDialogOpen` and `setPickerOpen` imports

#### `SidebarTabRow.tsx` — Fix Wiring

- Import `useAgentCreationStore` from `@/layers/shared/model` instead of using `useAppStore`
- - button → `useAgentCreationStore.getState().open()`
- Remove `setAgentDialogOpen` import

### Deletions

| File/Code                                                  | Reason                                                |
| ---------------------------------------------------------- | ----------------------------------------------------- |
| `agent-creation/model/use-template-catalog.ts`             | Built-in templates removed; marketplace is the source |
| `useTemplateCatalog` export from `agent-creation/index.ts` | Barrel cleanup                                        |
| Built-in template server endpoint (if dedicated)           | No longer consumed                                    |
| `TraitSliders` import in `CreateAgentDialog`               | Personality deferred to settings                      |
| `DiscoveryView` dialog in `AgentsHeader`                   | Discovery moved into unified dialog's Import tab      |

### Data Flow

```
User action (sidebar +, header button, Cmd+K, etc.)
  │
  ▼
useAgentCreationStore.open(tab?)
  │
  ▼
CreateAgentDialog opens → Tabs render with initialTab
  │
  ├─ Tab 1 (New Agent): Name + Location → useCreateAgent.mutate({ name, directory })
  ├─ Tab 2 (Template): TemplatePicker + Name + Location → useCreateAgent.mutate({ name, directory, template })
  └─ Tab 3 (Import): <DiscoveryView /> → useRegisterAgent (internal to DiscoveryView)
  │
  ▼
Server creates/registers agent → Query cache invalidated → Dialog closes → Agent list refreshes
```

## Implementation Phases

### Phase 1: State & Wiring (Foundation)

1. Extend `useAgentCreationStore` with `initialTab` field and typed `CreationTab` union
2. Fix `AddAgentMenu.tsx` — replace `setAgentDialogOpen`/`setPickerOpen` with `useAgentCreationStore`
3. Fix `SidebarTabRow.tsx` — replace `setAgentDialogOpen` with `useAgentCreationStore`
4. Update `agent-creation/index.ts` barrel — remove `useTemplateCatalog` export

### Phase 2: Dialog Redesign (Core)

5. Rewrite `CreateAgentDialog.tsx` with three-tab layout:
   - Tab 1: Name + Location (extracted from current dialog, minus personality/template)
   - Tab 2: TemplatePicker + Name + Location
   - Tab 3: `<DiscoveryView />`
   - Conditional footer (hide "Create" on Import tab)
   - Read `initialTab` from store
6. Simplify `TemplatePicker.tsx`:
   - Remove built-in template tab and `useTemplateCatalog` usage
   - Make marketplace grid the sole template source
   - Move custom GitHub URL into Advanced collapsible

### Phase 3: Cleanup (Simplification)

7. Simplify `AgentsHeader.tsx` — remove "Search for Projects" button, discovery dialog, and related state
8. Delete `use-template-catalog.ts`
9. Clean up unused imports across modified files

### Phase 4: Tests

10. Update `CreateAgentDialog` tests for three-tab behavior
11. Update `TemplatePicker` tests for marketplace-only + advanced URL
12. Update `AgentsHeader` tests (removed button)
13. Add/update tests for `AddAgentMenu` and `SidebarTabRow` entry point fixes
14. Verify `DiscoveryView` works inside the dialog tab (integration-level)

## Acceptance Criteria

### Functional

- [ ] Every entry point (sidebar +, session +, header button, Cmd+K) opens the same unified `CreateAgentDialog`
- [ ] Dialog has three tabs: "New Agent", "From Template", "Import"
- [ ] "New Agent" tab creates an agent with just name + location (no personality sliders)
- [ ] "From Template" tab shows marketplace agent templates in a card grid
- [ ] "From Template" tab has an Advanced collapsible with custom GitHub URL input
- [ ] "Import" tab renders `DiscoveryView` with working scan, results, and import
- [ ] "Create Agent" footer button is hidden when Import tab is active
- [ ] `AddAgentMenu` "Create agent" opens unified dialog (not editing dialog)
- [ ] `AddAgentMenu` "Import project" opens unified dialog on Import tab
- [ ] `SidebarTabRow` + button opens unified dialog (not editing dialog)
- [ ] `AgentsHeader` has a single "New Agent" button (no separate "Search for Projects")
- [ ] Built-in template catalog code is deleted
- [ ] No personality sliders in the creation dialog

### Non-Regression

- [ ] Existing agent creation via name + directory still works
- [ ] Existing agent creation via marketplace template still works
- [ ] Existing agent creation via custom GitHub URL still works
- [ ] Discovery scan and import still works (reused component)
- [ ] Command palette "Create agent" still works
- [ ] "Browse Dork Hub" in sidebar still navigates to marketplace
- [ ] Agent editing dialog (`AgentDialog`) is unaffected
- [ ] Onboarding flow is unaffected

### UX

- [ ] Dialog defaults to "New Agent" tab with name input auto-focused
- [ ] Location field auto-updates as user types the name
- [ ] Tab state resets when dialog is closed and reopened
- [ ] Dialog can be opened pre-focused on a specific tab (e.g., Import from sidebar menu)
