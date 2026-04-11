---
slug: create-agent-two-step-flow
number: 235
created: 2026-04-11
status: specified
linear-issue: null
design-session: .dork/visual-companion/96097-1775935464
---

# Create Agent Two-Step Wizard Flow — Specification

## Overview

Redesign `CreateAgentDialog` from a three-tab layout into a multi-step wizard with instant-advance method cards. Step 1 presents three method cards (Start Blank, From Template, Import Project). Clicking a card instantly transitions to the next step — no "Next" button. The template path includes a dedicated template picker step using marketplace `PackageCard` components. The configure step (name + directory) is shared by both blank and template paths, with template name auto-fill. Integrates the directory browser button (merged from spec #234) and `.dork` conflict detection.

### Goals

1. **Instant-advance wizard**: Method cards click to advance — zero wasted interactions
2. **Eliminate form duplication**: Single shared configure step for name + directory (fixes 170+ line DRY violation)
3. **Template auto-fill**: Selecting a template pre-populates the name field
4. **Reuse marketplace cards**: Template picker uses `PackageCard` with a new compact/selectable variant
5. **Directory browser**: Add browse button using existing `DirectoryPicker` component
6. **Conflict detection**: Debounced `.dork` detection with smart inline feedback
7. **Polished transitions**: `AnimatePresence` opacity fade between steps (matches `AdapterSetupWizard` pattern)
8. **Backward-compatible store API**: All existing callers continue working unchanged

### Non-Goals

- Onboarding UI changes (keeps own flow)
- Server-side creation pipeline changes
- Native OS file dialog integration (Electron `dialog.showOpenDialog`)
- Agent settings/editing dialog changes
- CLI/MCP tool creation paths
- Formal `StepIndicator` component (overkill for 2-3 steps)

## Technical Design

### Architecture: Multi-Step Wizard

Replace the Radix `Tabs` component with a step state machine. Step transitions use `AnimatePresence mode="wait"` + `motion.div key={step}` with opacity fade — the same pattern as `AdapterSetupWizard.tsx`.

```
┌──────────────────────────────────────────────────────┐
│  Create Agent                                        │
│  How do you want to start?                           │
│                                                      │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────┐ │
│  │   📝     │  │     📦       │  │      🔍        │ │
│  │  Start   │  │    From      │  │    Import      │ │
│  │  Blank   │  │  Template    │  │    Project     │ │
│  └──────────┘  └──────────────┘  └──��─────────────┘ │
│                                                      │
│  (no footer — clicking a card advances instantly)    │
└��─────────────────────────────────────────────────────┘
```

**Dialog sizing**: `sm:max-w-lg` (unchanged from current).

### State Machine

```typescript
type CreationMode = 'new' | 'template' | 'import';
type WizardStep = 'choose' | 'pick-template' | 'configure' | 'import';
```

**Step transitions:**

| From            | Action                      | To                                                          |
| --------------- | --------------------------- | ----------------------------------------------------------- |
| `choose`        | Click "Start Blank"         | `configure` (mode=new)                                      |
| `choose`        | Click "From Template"       | `pick-template` (mode=template)                             |
| `choose`        | Click "Import Project"      | `import` (mode=import)                                      |
| `pick-template` | Click a template card       | `configure` (mode=template, template set, name auto-filled) |
| `pick-template` | Enter custom URL + click Go | `configure` (mode=template, template set)                   |
| `pick-template` | Click Back                  | `choose`                                                    |
| `configure`     | Click Back (mode=new)       | `choose`                                                    |
| `configure`     | Click Back (mode=template)  | `pick-template`                                             |
| `configure`     | Click Create Agent          | Submit → close                                              |
| `import`        | Click Back                  | `choose`                                                    |

**Entry point mapping (backward-compatible):**

| `open()` call             | Initial state                             |
| ------------------------- | ----------------------------------------- |
| `open()` or `open('new')` | `step='choose'`                           |
| `open('template')`        | `step='pick-template'`, `mode='template'` |
| `open('import')`          | `step='import'`, `mode='import'`          |

### Step 1: Method Selection (`choose`)

Three method cards in a horizontal row. No footer buttons. Clicking a card instantly advances.

**Card layout:**

- 40px icon container with colored background (indigo for blank, purple for template, green for import)
- Title: 14px semibold
- Subtitle: 11px muted
- Cards are `<button>` elements with `card-interactive` class and `rounded-xl` border
- Hover: border highlight + subtle shadow lift
- Focus-visible: ring-2

**DialogDescription:** "How do you want to start?"

### Step 2a: Template Picker (`pick-template`)

Full-space template picker using marketplace `PackageCard` components in a scrollable grid.

**Layout:**

- 2-column grid (`grid grid-cols-2 gap-3`) of `PackageCard variant="compact"` components
- Scrollable container: `max-h-64 overflow-y-auto`
- Advanced collapsible below grid: custom GitHub URL input (same as current `TemplatePicker` behavior)
- Footer: `[← Back]` button only (left-aligned). No "Next" — clicking a template card advances.

**PackageCard interaction:**

- Clicking a card sets the `template` state to the package's source URL and immediately advances to `configure`
- No toggle/deselect behavior — single click advances

**DialogDescription:** "Pick a template"

### Step 2b: Configure (`configure`)

Name + directory form. Shared by both blank and template paths.

**Fields:**

- **Template indicator** (template path only): Subtle chip showing selected template icon + name + "Change" link. "Change" navigates back to `pick-template`.

  ```
  ┌─────────────────────────────────────────┐
  │ 🕷️  web-scraper                 Change  │
  │     Template selected                   │
  └─────────────────────────────────────────┘
  ```

- **Name** (text input, required, auto-focused):
  - Validated via `validateAgentName()`
  - Template path: pre-filled from selected template's `name` field. Hint text: "Pre-filled from template — edit freely"
  - Auto-fill logic: on entering `configure` step, if `creationMode === 'template'` and `name` is empty, set `name` to the template package's `name`

- **Location** (auto-generated path preview + collapsible override):
  - Default preview: `{defaultDirectory}/{name}` shown as muted text below name input
  - Collapsible "Directory" section (same pattern as current implementation):
    - Toggle button with chevron + "custom" badge when override is set
    - Text input + browse button (`FolderOpen` icon) that opens `DirectoryPicker` modal
    - `DirectoryPicker` props: `initialPath={directoryOverride || defaultDirectory}`, `onSelect={setDirectoryOverride}`

- **Conflict detection** (inline, below location):
  - Debounced 500ms check after `directoryOverride` or `name` changes
  - Uses `transport.browseDirectory(resolvedPath)` to check if path exists, then checks for `.dork` subdirectory in the response entries
  - States:
    - Default (no check yet): no indicator
    - Path doesn't exist: `"Will create new directory"` (muted text, no icon)
    - Path exists, no `.dork`: `"Directory exists — will create project inside"` (muted text)
    - Path exists, has `.dork`: `"Existing project detected"` (warning text) + `"Import instead?"` link that navigates to `import` step
    - Error / permission denied: `"Cannot access this path"` (error text, disables Create button)

**Footer:** `[← Back]` (left) + `[Create Agent]` (right, primary). Back goes to `choose` (blank path) or `pick-template` (template path).

**DialogDescription:** "Name your agent"

### Step 2c: Import (`import`)

Renders `DiscoveryView` component as-is. Self-contained with its own scan, results, and import actions.

**Footer:** `[← Back]` button only (left-aligned). No "Create Agent" — DiscoveryView handles its own actions.

**DialogDescription:** "Scan for existing projects"

### PackageCard Compact Variant

Add a `variant` prop to the existing `PackageCard` component using `cva` or a simple conditional.

**`variant="compact"` changes from default:**

- Smaller padding: `p-4` instead of `p-6`
- No author/source line
- No install button — the entire card is the click target
- No featured star indicator
- Type badge still visible (confirms it's an agent template)
- Description: `line-clamp-2` (same as default)

**Props additions:**

```typescript
interface PackageCardProps {
  pkg: AggregatedPackage;
  installed?: boolean;
  onClick: () => void;
  onInstallClick?: (e: React.MouseEvent) => void;
  /** Card display variant. 'compact' hides author and install button. */
  variant?: 'default' | 'compact';
}
```

When `variant="compact"`:

- Skip the author row render
- Skip the action row (install button / installed indicator) render
- Use `p-4` instead of `p-6`

### Animation

Step transitions use `AnimatePresence mode="wait"` wrapping a `motion.div` keyed on the current step:

```tsx
<AnimatePresence mode="wait">
  <motion.div
    key={step}
    initial={{ opacity: 0 }}
    animate={{ opacity: 1 }}
    exit={{ opacity: 0 }}
    transition={{ duration: 0.15 }}
  >
    {step === 'choose' && <MethodSelection ... />}
    {step === 'pick-template' && <TemplatePicker ... />}
    {step === 'configure' && <ConfigureForm ... />}
    {step === 'import' && <DiscoveryView />}
  </motion.div>
</AnimatePresence>
```

This is identical to the pattern in `AdapterSetupWizard.tsx` lines 100-157.

### Store Changes

Rename the type for clarity but keep the API surface backward-compatible:

```typescript
// shared/model/agent-creation-store.ts
export type CreationMode = 'new' | 'template' | 'import';

// Keep CreationTab as deprecated alias for backward compat
/** @deprecated Use CreationMode instead */
export type CreationTab = CreationMode;

interface AgentCreationState {
  isOpen: boolean;
  initialMode: CreationMode;
  open: (mode?: CreationMode) => void;
  close: () => void;
}

export const useAgentCreationStore = create<AgentCreationState>((set) => ({
  isOpen: false,
  initialMode: 'new',
  open: (mode?: CreationMode) => set({ isOpen: true, initialMode: mode ?? 'new' }),
  close: () => set({ isOpen: false, initialMode: 'new' }),
}));
```

The `open(mode?)` signature accepts the same string literals as `open(tab?)` — all callers continue working. The internal field renames from `initialTab` to `initialMode`.

Re-export from `shared/model/index.ts`:

```typescript
export { useAgentCreationStore, type CreationMode, type CreationTab } from './agent-creation-store';
```

### Accessibility

- **Focus management:** On advancing to `configure` step, focus the name `<Input>` via ref. On advancing to `pick-template`, focus the first template card. On advancing to `import`, let DiscoveryView handle its own focus.
- **`aria-live` announcement:** Visually hidden `<span aria-live="polite" aria-atomic="true">` in the dialog that updates with step description text (e.g., "Step 2: Name your agent") on step change.
- **Back button:** First in DOM order on steps 2+, so Tab order is intuitive.
- **Method cards:** `role="button"` (implicit from `<button>` elements), descriptive labels including the subtitle text.
- **Escape / overlay click:** Handled by Radix Dialog — no changes needed.

### Data Flow

```
User action (sidebar +, header button, Cmd+K, etc.)
  │
  ▼
useAgentCreationStore.open(mode?)
  │
  ▼
CreateAgentDialog opens → Step 1: Method Selection (choose)
  │
  ├─ Click "Start Blank"
  │   └─ Step: configure (mode=new) → Name + Directory → Create Agent
  │
  ├─ Click "From Template"
  │   └─ Step: pick-template → Click template card
  │       └─ Step: configure (mode=template, name pre-filled) → Create Agent
  │
  └─ Click "Import Project"
      └─ Step: import → DiscoveryView (self-contained scan + import)
  │
  ▼
Server creates/registers agent → Cache invalidated → Dialog closes → Celebration → Agent list refreshes
```

## Component Changes

### `CreateAgentDialog.tsx` — Major Rewrite

- Remove `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` imports
- Add `AnimatePresence`, `motion` from `motion/react`
- Add `DirectoryPicker` from `shared/ui`
- Add `FolderOpen` from `lucide-react`
- Replace tab state with wizard step state machine:
  - `step: WizardStep` (choose | pick-template | configure | import)
  - `creationMode: CreationMode` (new | template | import)
- Extract inline components or sections:
  - `MethodSelection` — three method cards
  - `ConfigureForm` — name + directory + conflict detection + template indicator
- Keep `TemplatePicker` for the `pick-template` step (used as-is, but with PackageCard compact variant)
- Template auto-fill: on entering configure step, set name from template if empty
- Directory browser: `FolderOpen` button next to directory input opens `DirectoryPicker`
- Conflict detection: debounced `browseDirectory` check with inline status text
- Conditional footer: Back button context-aware, Create Agent only on configure step
- Animate step transitions with `AnimatePresence mode="wait"`

### `PackageCard.tsx` — Add Variant

- Add `variant?: 'default' | 'compact'` prop
- When `variant="compact"`: skip author row, skip action row (install button), use `p-4` padding
- No changes to default variant behavior

### `TemplatePicker.tsx` — Adapt for Wizard

- Update to use `PackageCard variant="compact"` instead of custom inline card markup
- Remove the `Label` ("Template (optional)") — the step title serves as the label
- Keep the Advanced collapsible for custom GitHub URL
- Change the `onSelect` interaction: clicking a card calls `onSelect` (parent handles advancing)
- Import `PackageCard` from `@/layers/features/marketplace`

Note on FSD layer: `TemplatePicker` lives in `features/agent-creation`. Importing `PackageCard` from `features/marketplace` is allowed under the FSD cross-feature UI composition rule (feature UI can render sibling feature components).

### `agent-creation-store.ts` — Type Rename

- Rename `CreationTab` → `CreationMode`
- Rename `initialTab` → `initialMode`
- Keep `CreationTab` as deprecated type alias
- API signature unchanged: `open(mode?: CreationMode)`

### `shared/model/index.ts` — Update Re-exports

- Add `CreationMode` to exports
- Keep `CreationTab` export for backward compatibility

### No Changes Required

- `use-create-agent.ts` — mutation hook unchanged
- `DiscoveryView.tsx` — reused as-is
- `DirectoryPicker.tsx` — reused as-is
- `AddAgentMenu.tsx` — `open('import')` continues to work
- `SidebarTabRow.tsx` — `open()` continues to work
- `AgentsHeader.tsx` — `open()` continues to work
- `AppShell.tsx` — `<CreateAgentDialog />` unchanged

## Implementation Phases

### Phase 1: Foundation (State & Variant)

1. Update `agent-creation-store.ts` — rename type, add deprecated alias
2. Update `shared/model/index.ts` — add `CreationMode` export
3. Add `variant` prop to `PackageCard.tsx`

### Phase 2: Core Wizard (Dialog Rewrite)

4. Rewrite `CreateAgentDialog.tsx` — wizard state machine, method cards, AnimatePresence transitions, conditional footer
5. Update `TemplatePicker.tsx` — use `PackageCard variant="compact"`, remove Label, adapt onSelect

### Phase 3: Enhancements

6. Add directory browser button — `FolderOpen` icon button + `DirectoryPicker` integration
7. Add template name auto-fill — pre-populate name from selected template
8. Add `.dork` conflict detection — debounced `browseDirectory` check with inline status

### Phase 4: Tests

9. Rewrite `CreateAgentDialog.test.tsx` — step navigation, method selection, back navigation, template auto-fill, directory browser
10. Update `TemplatePicker.test.tsx` — PackageCard usage, onSelect behavior change
11. Add `PackageCard` variant tests — compact variant renders without author/action
12. Verify entry point backward compatibility — `AddAgentMenu`, `SidebarTabRow`, `AgentsHeader` store calls still work

## Acceptance Criteria

### Functional

- [ ] Dialog opens with three method cards: "Start Blank", "From Template", "Import Project"
- [ ] Clicking "Start Blank" instantly shows configure step (name + directory form)
- [ ] Clicking "From Template" instantly shows template picker with marketplace agent cards
- [ ] Clicking a template card instantly shows configure step with name pre-filled from template
- [ ] Clicking "Import Project" instantly shows DiscoveryView
- [ ] Back button on configure step returns to method selection (blank) or template picker (template)
- [ ] Back button on template picker returns to method selection
- [ ] Back button on import returns to method selection
- [ ] Template indicator chip on configure step shows selected template with "Change" link
- [ ] "Change" link navigates back to template picker (preserving other form state)
- [ ] Name field is auto-focused on configure step
- [ ] Name validation displays inline error for invalid names
- [ ] Directory preview auto-updates as name is typed
- [ ] Directory browser button opens DirectoryPicker modal
- [ ] DirectoryPicker selection populates directory override
- [ ] `.dork` conflict detection shows appropriate status for each directory state
- [ ] "Import instead?" link in conflict detection navigates to import step
- [ ] Create Agent button submits with correct payload (name, directory, template)
- [ ] Successful creation closes dialog, plays celebration, invalidates cache
- [ ] Failed creation shows error toast
- [ ] Form resets when dialog closes
- [ ] Step transitions animate with opacity fade

### Entry Point Compatibility

- [ ] `AddAgentMenu` "Create agent" opens dialog at method selection
- [ ] `AddAgentMenu` "Import project" opens dialog at import step
- [ ] `SidebarTabRow` + button opens dialog at method selection
- [ ] `AgentsHeader` "New Agent" opens dialog at method selection
- [ ] Command palette "Create agent" opens dialog at method selection

### Non-Regression

- [ ] Agent creation via name + directory still works (blank path)
- [ ] Agent creation via marketplace template still works (template path)
- [ ] Agent creation via custom GitHub URL still works (Advanced section)
- [ ] Discovery scan and import still works (reused DiscoveryView)
- [ ] Marketplace PackageCard default variant is unchanged
- [ ] Agent editing dialog (`AgentDialog`) is unaffected
- [ ] Onboarding flow is unaffected

### UX Polish

- [ ] Method cards have hover states with border highlight and subtle shadow
- [ ] Step transitions are smooth 150ms opacity fades
- [ ] Template name auto-fill feels like a suggestion (editable, hint text visible)
- [ ] Directory browser opens at the relevant path (override or default)
- [ ] Conflict detection is debounced (no flicker on rapid typing)
- [ ] Dialog description text updates per step for orientation

### Deferred Work

- Real-time conflict detection adopt fast-path (auto-switch to import when `.dork` detected) — include link but not auto-switch for now
- Onboarding hook convergence (`useInitAgent` → `useCreateAgent`)
- Native OS file dialog via Electron `dialog.showOpenDialog`
- Template search/filter for large template catalogs (>15 templates)
