# Task Breakdown: Tabbed Dialog Primitive

Generated: 2026-04-06
Source: specs/settings-dialog-02-tabbed-primitive/02-specification.md
Last Decompose: 2026-04-06

## Overview

Extract a `TabbedDialog` widget primitive into `shared/ui/` that owns the chrome currently duplicated across `SettingsDialog` and `AgentDialog`. Ship three supporting primitives at the same time (`useDialogTabState`, `SettingsPanel`, `SwitchSettingRow`), refactor both consumer dialogs to thin declarative shapes (~50 and ~60 lines respectively), convert ~17 `SettingRow+Switch` instances to the new shorthand, and add `⌘1`-`⌘9` keyboard shortcuts.

Decomposed into 6 phases (37 tasks total) with strict dependency ordering. Phase 1 builds the shared primitives in isolation, Phase 2 migrates row-level shorthand, Phase 3 makes the parametric tabs self-contained, Phases 4 and 5 are the major refactors (each can ship as an independent commit), and Phase 6 wraps with verification and docs.

## Phase 1: Shared primitives

Build the new `shared/ui/` and `shared/model/` exports with full test coverage. No consumer changes yet — by the end of this phase, the new APIs are available but unused.

### Task 1.1: Create useDialogTabState hook

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: 1.3, 1.5

**Technical Requirements**:

- New file at `apps/client/src/layers/shared/model/use-dialog-tab-state.ts`
- Generic over `<T extends string>`
- TSDoc on the export
- No `useEffect` — uses `useState` only
- Implements the React 19 "adjust state during render" pattern

**Acceptance Criteria**:

- [ ] File exists, exports `useDialogTabState<T>`
- [ ] `pnpm typecheck` passes

### Task 1.2: Add tests for useDialogTabState

**Size**: Small
**Priority**: High
**Dependencies**: 1.1
**Can run parallel with**: 1.4, 1.6

**Test cases** (6 total):

- returns defaultTab when initialTab is null
- returns initialTab when set on initial render
- updates activeTab when setActiveTab is called
- re-syncs to initialTab when dialog re-opens with a new initialTab
- does NOT re-sync when only setActiveTab is called (no open transition)
- preserves activeTab across re-renders when open is stable

### Task 1.3: Add SwitchSettingRow export to setting-row.tsx

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: 1.1, 1.5

**Technical Requirements**:

- Add `SwitchSettingRow` and `SwitchSettingRowProps` to existing `apps/client/src/layers/shared/ui/setting-row.tsx`
- Defaults `aria-label` to `label` when `ariaLabel` not provided
- Forwards `disabled`, `className` to underlying `SettingRow` + `Switch`
- Existing `SettingRow` export untouched

### Task 1.4: Add tests for SwitchSettingRow

**Size**: Small
**Priority**: High
**Dependencies**: 1.3
**Can run parallel with**: 1.2, 1.6

**Test cases** (6 total):

- renders label and description
- forwards checked state to the Switch
- calls onCheckedChange when toggled
- uses label as default aria-label
- honors custom ariaLabel override
- forwards disabled state to the Switch

### Task 1.5: Create SettingsPanel shorthand

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: 1.1, 1.3

**Technical Requirements**:

- New file at `apps/client/src/layers/shared/ui/settings-panel.tsx`
- Wraps `NavigationLayoutPanel` + `space-y-4` + `NavigationLayoutPanelHeader`
- For consumers using bare `NavigationLayout` (NOT `TabbedDialog`)

### Task 1.6: Add tests for SettingsPanel

**Size**: Small
**Priority**: High
**Dependencies**: 1.5
**Can run parallel with**: 1.2, 1.4

**Test cases** (4 total):

- renders title in the panel header
- renders actions slot when provided
- renders children inside a space-y-4 wrapper
- renders nothing when value does not match the parent NavigationLayout active tab

### Task 1.7: Create TabbedDialog widget

**Size**: Large
**Priority**: High
**Dependencies**: 1.1, 1.3
**Can run parallel with**: —

**Technical Requirements**:

- New file at `apps/client/src/layers/shared/ui/tabbed-dialog.tsx`
- Generic `<T extends string>` for type-safe tab IDs
- `TabbedDialogTab<T>` interface with `id`, `label`, `icon`, `component`, optional `actions`
- Wraps `ResponsiveDialog` → `NavigationLayout` → tab loop
- Renders panels via `tabs.map`, each wrapped in `<Suspense>`
- Internal `useTabKeyboardShortcuts` hook implements ⌘1-⌘9
- Accepts `sidebarExtras`, `extensionSlot`, `headerSlot`, `maxWidth`, `minHeight`, `testId`
- Extension slot type currently restricted to `'settings.tabs'`

### Task 1.8: Add tests for TabbedDialog

**Size**: Large
**Priority**: High
**Dependencies**: 1.7
**Can run parallel with**: —

**Test cases** (18 total):

- renders all built-in tabs in the sidebar
- renders the active panel content
- switches active tab on sidebar click
- honors initialTab on first open
- honors initialTab when re-opened with a different value
- falls back to defaultTab when initialTab is null
- renders sidebarExtras after the tab list
- merges extension contributions when extensionSlot is set
- does not merge extension contributions when extensionSlot is undefined
- renders the title and description
- renders headerSlot under the title
- switches tabs via ⌘1, ⌘2, ⌘3 keyboard shortcuts
- ignores number key presses without modifier
- does not respond to keyboard shortcuts when closed
- caps shortcuts at ⌘9 (does not handle ⌘0)
- passes maxWidth and minHeight overrides to the dialog
- wraps panels in Suspense for lazy components
- uses the testId prop for the dialog element

### Task 1.9: Update shared barrels

**Size**: Small
**Priority**: High
**Dependencies**: 1.1, 1.3, 1.5, 1.7
**Can run parallel with**: —

**Technical Requirements**:

- `shared/ui/index.ts`: export `TabbedDialog`, `TabbedDialogProps`, `TabbedDialogTab`, `SettingsPanel`, `SettingsPanelProps`, `SwitchSettingRow`, `SwitchSettingRowProps`
- `shared/model/index.ts`: export `useDialogTabState` and `type SettingsTab` (currently absent — required by Phase 4)

### Task 1.10: Phase 1 verification gate

**Size**: Small
**Priority**: High
**Dependencies**: 1.2, 1.4, 1.6, 1.8, 1.9

Run `pnpm typecheck`, `pnpm vitest run apps/client/src/layers/shared`, `pnpm lint apps/client/src/layers/shared`. Commit: `feat(shared): add TabbedDialog primitive and supporting hooks`.

## Phase 2: SwitchSettingRow migrations

Convert all `<SettingRow>+<Switch>` instances. Tasks 2.1-2.6 are fully parallelizable (different files, no shared edits). 2.2 has a soft dependency on 2.7 (the AdvancedTab structural refactor in Phase 3) — but the row conversions in 2.2 are independent of the prop signature changes in 3.3.

### Task 2.1: Convert PreferencesTab to SwitchSettingRow

**Size**: Small
**Priority**: Medium
**Dependencies**: 1.10
**Can run parallel with**: 2.2, 2.3, 2.4, 2.5, 2.6

Convert all 9 `<SettingRow>+<Switch>` instances in `apps/client/src/layers/features/settings/ui/tabs/PreferencesTab.tsx`. (Note: spec table says 8, actual count is 9.) Drop `Switch` and `SettingRow` from imports.

### Task 2.2: Convert AdvancedTab toggle rows

**Size**: Small
**Priority**: Medium
**Dependencies**: 1.10
**Can run parallel with**: 2.1, 2.3, 2.4, 2.5, 2.6

Convert the 2 toggle rows in `AdvancedTab.tsx` (`Multi-window sync`, `Background refresh`). Leave the Select/Input/custom rows as `SettingRow`. Do NOT touch the prop signature — that's task 3.3.

### Task 2.3: Audit AgentsTab for conversions

**Size**: Small
**Priority**: Low
**Dependencies**: 1.10
**Can run parallel with**: 2.1, 2.2, 2.4, 2.5, 2.6

Pre-investigation: 0 simple toggle rows expected. AgentsTab has Select/Input controls only.

### Task 2.4: Audit agent-settings tabs for conversions

**Size**: Small
**Priority**: Low
**Dependencies**: 1.10
**Can run parallel with**: 2.1, 2.2, 2.3, 2.5, 2.6

Pre-investigation found:

- `ContextTab.tsx` (line 84-98): `<SettingRow>` with Switch + conditional Badge — SKIP (compound row)
- `ToolsTab.tsx` (lines 131, 151): Tooltip + Badge + Switch + Reset — SKIP (compound row)
- `PersonalityTab.tsx` (line 205): `<SettingRow>` with `<Select>` — not a toggle
- No `CapabilitiesTab.tsx` exists in the codebase

Likely 0 conversions needed. Document the audit result.

### Task 2.5: Convert RateLimitSection rate-limit toggle

**Size**: Small
**Priority**: Medium
**Dependencies**: 1.10
**Can run parallel with**: 2.1, 2.2, 2.3, 2.4, 2.6

Convert the rate-limit toggle in `external-mcp/RateLimitSection.tsx`. Note prop rename: `aria-label` → `ariaLabel`.

### Task 2.6: Convert StatusBarTab StatusBarSettingRow

**Size**: Small
**Priority**: Medium
**Dependencies**: 1.10
**Can run parallel with**: 2.1, 2.2, 2.3, 2.4, 2.5

Convert the inner `StatusBarSettingRow` helper to use `SwitchSettingRow`.

### Task 2.7: Phase 2 verification gate

**Size**: Small
**Priority**: High
**Dependencies**: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6

Run typecheck, vitest, lint, plus a grep verification that no `<SettingRow>+<Switch>` patterns remain in the converted files. Visual smoke check. Commit: `refactor(settings): use SwitchSettingRow shorthand for toggle rows`.

## Phase 3: ServerTab and AdvancedTab self-contained refactor

Make the two parametric tabs (`ServerTab` and `AdvancedTab`) parameterless so they fit `TabbedDialog`'s `component: ComponentType` shape. Lift the `restartOverlayOpen` state to the app store and re-mount `ServerRestartOverlay` via `DialogHost`.

### Task 3.1: Make ServerTab self-contained

**Size**: Medium
**Priority**: High
**Dependencies**: 1.10
**Can run parallel with**: 3.2

Move `useQuery(['config'])` inside `ServerTab`. Remove `config`/`isLoading` props. Drop the `enabled: open` query option (mount/unmount lifecycle replaces it).

### Task 3.2: Add restartOverlayOpen to panels slice

**Size**: Small
**Priority**: High
**Dependencies**: 1.10
**Can run parallel with**: 3.1

Add `restartOverlayOpen: boolean` and `setRestartOverlayOpen: (open: boolean) => void` to `app-store-panels.ts`. Pattern matches existing `relayOpen`/`setRelayOpen`.

### Task 3.3: Refactor AdvancedTab to dispatch to store

**Size**: Medium
**Priority**: High
**Dependencies**: 3.2, 2.2
**Can run parallel with**: —

Remove `AdvancedTabProps` interface and the `onResetComplete`/`onRestartComplete` callbacks. Subscribe to `setRestartOverlayOpen` from the store. Update `apps/client/src/layers/features/settings/__tests__/AdvancedTab.test.tsx` to drop those props.

### Task 3.4: Create ServerRestartOverlayWrapper

**Size**: Small
**Priority**: High
**Dependencies**: 3.2
**Can run parallel with**: 3.3

New file at `apps/client/src/layers/widgets/app-layout/model/wrappers/ServerRestartOverlayWrapper.tsx`. Adapts `ServerRestartOverlay`'s `{ open, onDismiss }` shape to the standard `{ open, onOpenChange }` `DialogContribution` signature.

### Task 3.5: Register ServerRestartOverlay as dialog contribution

**Size**: Small
**Priority**: High
**Dependencies**: 3.2, 3.4

Append `{ id: 'server-restart-overlay', component: ServerRestartOverlayWrapper, openStateKey: 'restartOverlayOpen', priority: 7 }` to `DIALOG_CONTRIBUTIONS`.

### Task 3.6: Remove ServerRestartOverlay sibling from SettingsDialog

**Size**: Small
**Priority**: High
**Dependencies**: 3.3, 3.5

Delete the `ServerRestartOverlay` import, the local `restartOverlayOpen` state, the `<AdvancedTab>` callback props, and the `<ServerRestartOverlay>` JSX block from `SettingsDialog.tsx`. Also drop `config={config} isLoading={isLoading}` from `<ServerTab>` (matches task 3.1).

### Task 3.7: Phase 3 verification gate

**Size**: Small
**Priority**: High
**Dependencies**: 3.1, 3.6

Typecheck, vitest, lint. Manual smoke: open Settings → Advanced → Reset → confirm overlay still appears (now via `DialogHost`). Commit: `refactor(settings): make ServerTab and AdvancedTab self-contained`.

## Phase 4: SettingsDialog refactor

### Task 4.1: Refactor SettingsDialog to consume TabbedDialog

**Size**: Medium
**Priority**: High
**Dependencies**: 1.10, 3.7

Replace the 177-line file body with a ~50-line declarative consumer. Define `SETTINGS_TABS` array, render `<TabbedDialog>` with `sidebarExtras={<RemoteAccessAction ...>}` and `extensionSlot="settings.tabs"`. Drop all `useState`/`useEffect`/`useQuery` hooks except the `tunnelDialogOpen` local state.

### Task 4.2: Verify RemoteAccessAction and extension tabs

**Size**: Small
**Priority**: Medium
**Dependencies**: 4.1
**Can run parallel with**: 4.3

Manual smoke check. Note: `RemoteAccessAction` placement may have moved (currently sits between Server and Tools tabs; after refactor it sits after all tabs because `sidebarExtras` is rendered after the tab list per spec §6.2). Confirm acceptance with the user.

### Task 4.3: Update SettingsDialog tests for new shape

**Size**: Small
**Priority**: High
**Dependencies**: 4.1
**Can run parallel with**: 4.2

Update `__tests__/SettingsDialog.test.tsx`. Remove any `<ServerRestartOverlay>` sibling assertions. Use the standard mock-transport pattern.

### Task 4.4: Phase 4 verification gate

**Size**: Small
**Priority**: High
**Dependencies**: 4.1, 4.2, 4.3

Typecheck, vitest, lint, `wc -l SettingsDialog.tsx` (target < 70 lines). Manual smoke of every tab + ⌘ shortcuts + deep-link entry point. Commit: `refactor(settings): consume TabbedDialog primitive`.

## Phase 5: AgentDialog refactor

Per Q3 in spec §13, consumer wrappers live under a `consumers/` subdirectory.

### Task 5.1: Create AgentDialogContext provider

**Size**: Small
**Priority**: High
**Dependencies**: 1.10
**Can run parallel with**: 5.2

New file at `apps/client/src/layers/features/agent-settings/model/agent-dialog-context.tsx`. Defines `AgentDialogContextValue`, `AgentDialogProvider`, `useAgentDialog`. Throws if used outside the provider.

### Task 5.2: Extract NoAgentFallback component

**Size**: Small
**Priority**: High
**Dependencies**: 1.10
**Can run parallel with**: 5.1

Extract the "no agent registered" branch from `AgentDialog.tsx` lines 75-95 into a standalone `NoAgentFallback.tsx`.

### Task 5.3: Create IdentityTabConsumer

**Size**: Small
**Priority**: High
**Dependencies**: 5.1
**Can run parallel with**: 5.4, 5.5, 5.6

New file at `consumers/IdentityTabConsumer.tsx`. Reads `agent` and `onUpdate` from context, forwards to `IdentityTab`.

### Task 5.4: Create PersonalityTabConsumer

**Size**: Small
**Priority**: High
**Dependencies**: 5.1
**Can run parallel with**: 5.3, 5.5, 5.6

New file at `consumers/PersonalityTabConsumer.tsx`. Reads `agent` and `onPersonalityUpdate` from context. Re-defines the `AgentWithConventions` augmented type inline (mirroring current `AgentDialog.tsx` line 29).

### Task 5.5: Create ToolsTabConsumer

**Size**: Small
**Priority**: High
**Dependencies**: 5.1
**Can run parallel with**: 5.3, 5.4, 5.6

New file at `consumers/ToolsTabConsumer.tsx`. Reads `agent`, `projectPath`, `onUpdate` from context.

### Task 5.6: Create ChannelsTabConsumer

**Size**: Small
**Priority**: High
**Dependencies**: 5.1
**Can run parallel with**: 5.3, 5.4, 5.5

New file at `consumers/ChannelsTabConsumer.tsx`. Reads only `agent` from context.

### Task 5.7: Refactor AgentDialog to consume TabbedDialog

**Size**: Medium
**Priority**: High
**Dependencies**: 5.2, 5.3, 5.4, 5.5, 5.6

Replace the 177-line file body with a ~60-line declarative consumer. Define `AGENT_TABS`, wrap `<TabbedDialog>` in `<AgentDialogProvider>`, delegate the no-agent branch to `<NoAgentFallback>`, render the project path breadcrumb via `headerSlot`. Drop the `useState<AgentDialogTab>`, `prevOpen` adjust-during-render block, and `AgentWithConventions` type definition.

### Task 5.8: Update AgentDialog tests for new shape

**Size**: Small
**Priority**: High
**Dependencies**: 5.7

Update `__tests__/AgentDialog.test.tsx`. Existing inner-tab tests (`IdentityTab.test.tsx`, etc.) are unchanged.

### Task 5.9: Phase 5 verification gate

**Size**: Small
**Priority**: High
**Dependencies**: 5.7, 5.8

Typecheck, vitest, lint, `wc -l AgentDialog.tsx` (target < 80). Manual smoke of all 4 tabs + edit/save flows + no-agent fallback + ⌘ shortcuts + deep-link. Commit: `refactor(agent-settings): consume TabbedDialog primitive`.

## Phase 6: Verification + docs

### Task 6.1: Run full project verification gate

**Size**: Small
**Priority**: High
**Dependencies**: 5.9
**Can run parallel with**: 6.2

`pnpm typecheck && pnpm test -- --run && pnpm lint && pnpm format --check`.

### Task 6.2: Verify file-size targets

**Size**: Small
**Priority**: Medium
**Dependencies**: 5.9
**Can run parallel with**: 6.1

`SettingsDialog.tsx` < 100 lines, `AgentDialog.tsx` < 100 lines (per spec §1).

### Task 6.3: Manual smoke test of ⌘1-⌘9 shortcuts

**Size**: Small
**Priority**: High
**Dependencies**: 6.1
**Can run parallel with**: 6.4

Verify ⌘1-⌘8 works in SettingsDialog, ⌘1-⌘4 works in AgentDialog, scoped to dialog open state, no browser tab-switching conflict. Document evidence.

### Task 6.4: Manual smoke test of all tabs and deep-links

**Size**: Medium
**Priority**: High
**Dependencies**: 6.1
**Can run parallel with**: 6.3

Open every tab in both dialogs. Test `openSettingsToTab(...)` and `openAgentDialogToTab(...)` from DevTools console. Verify re-open with new initial tab honors the new value.

### Task 6.5: Add Playwright E2E test for ⌘1 shortcut

**Size**: Small
**Priority**: Low
**Dependencies**: 6.1
**Can run parallel with**: 6.3, 6.4, 6.6, 6.7

OPTIONAL per §8.3. New file at `apps/e2e/tests/settings/keyboard-shortcuts.spec.ts`. Use the verbatim test from §8.3.

### Task 6.6: Document TabbedDialog in contributing/architecture.md

**Size**: Small
**Priority**: Medium
**Dependencies**: 5.9
**Can run parallel with**: 6.5, 6.7

Add a "Tabbed dialog primitive" section explaining when to use `TabbedDialog` vs. raw `NavigationLayout`.

### Task 6.7: Document useDialogTabState in contributing/state-management.md

**Size**: Small
**Priority**: Medium
**Dependencies**: 5.9
**Can run parallel with**: 6.5, 6.6

Add `useDialogTabState` as the canonical pattern for dialog deep-link sync.

### Task 6.8: Add changelog entry for keyboard shortcuts

**Size**: Small
**Priority**: Low
**Dependencies**: 6.1
**Can run parallel with**: 6.5, 6.6, 6.7

Entry: `Settings: ⌘1-⌘9 keyboard shortcuts to switch between tabs`.

## Critical path

```
1.1 → 1.7 → 1.8 → 1.10 → 3.1/3.2 → 3.3 → 3.4 → 3.5 → 3.6 → 3.7 → 4.1 → 4.4
                                                                  ↓
                                                  5.1/5.2 → 5.3-5.6 → 5.7 → 5.8 → 5.9 → 6.1 → 6.3/6.4
```

The deep dependency chain: `useDialogTabState` (1.1) blocks `TabbedDialog` (1.7), which blocks the test gate (1.10), which gates everything in Phases 2-5. Phase 3 must complete before Phase 4 can start (because `SettingsDialog.tsx` consumes the now-parameterless `ServerTab` and `AdvancedTab`). Phase 4 and Phase 5 are independent of each other after Phase 3 lands — they could be done in parallel by two contributors.

## Parallel opportunities

- **Phase 1**: Tasks 1.1, 1.3, 1.5 in parallel (no deps); 1.2/1.4/1.6 in parallel after their respective hook/component lands; 1.7 → 1.8 sequential
- **Phase 2**: Tasks 2.1-2.6 fully parallel (different files, no overlap)
- **Phase 3**: Tasks 3.1 and 3.2 in parallel; 3.3 and 3.4 in parallel after 3.2
- **Phase 4 vs Phase 5**: After Phase 3 lands, Phase 4 and Phase 5 can run in parallel by two contributors (different file trees)
- **Phase 5 internal**: Tasks 5.3, 5.4, 5.5, 5.6 (the four consumer wrappers) fully parallel after 5.1 lands
- **Phase 6**: Tasks 6.1/6.2, 6.3/6.4, 6.5/6.6/6.7/6.8 mostly parallel
