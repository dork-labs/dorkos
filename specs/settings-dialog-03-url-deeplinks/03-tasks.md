# Task Breakdown: Dialog URL Deeplinks

Generated: 2026-04-06
Source: specs/settings-dialog-03-url-deeplinks/02-specification.md
Last Decompose: 2026-04-06

## Overview

Migrate dialog deep-linking from the Zustand `panels` slice to TanStack Router search params. After this spec, every modal dialog in DorkOS — Settings, Agent, Tasks, Relay, Mesh — is URL-addressable, shareable, bookmarkable, and respects browser history.

The migration is **additive**: `RegistryDialog` reads BOTH the URL signal and the existing store flag (`storeOpen || urlSignal.isOpen`) so legacy store-based opens continue to work as a fallback. Closing the dialog clears both signals. New code uses URL-based hooks.

URLs after this spec:

```
/agents?settings=open                                  → Settings dialog (default tab) on Agents page
/session?session=abc123&settings=tools                 → Settings → Tools tab on Session page
/?settings=tools&settingsSection=external-mcp          → Settings → Tools tab, scrolled to External MCP
/?agent=identity&agentPath=/abs/path/to/repo           → Agent dialog → Identity tab for that project
/?tasks=open                                           → Tasks dialog
/?relay=open                                           → Relay dialog
/?mesh=open                                            → Mesh dialog
```

---

## Phase 1: Foundation

### Task 1.1: Create dialog search schema and mergeDialogSearch helper

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: —

Creates `apps/client/src/layers/shared/model/dialog-search-schema.ts` containing the `dialogSearchSchema` Zod object plus the `mergeDialogSearch<T>(routeSchema)` helper.

Schema fields: `settings`, `settingsSection`, `agent`, `agentPath`, `tasks`, `relay`, `mesh` — all `z.string().optional()`.

**Pre-flight check:** grep `apps/client/src/router.tsx` for any existing route that already declares `settings`, `agent`, `tasks`, `relay`, or `mesh` keys (none should match per spec §13 Q5).

**Acceptance**:

- [ ] File created with TSDoc on every export
- [ ] `pnpm typecheck` + `pnpm lint` green
- [ ] Pre-flight grep result recorded

---

### Task 1.2: Wrap every route validateSearch in router.tsx with mergeDialogSearch

**Size**: Small
**Priority**: High
**Dependencies**: 1.1
**Can run parallel with**: —

Apply `mergeDialogSearch` to all four route schemas in `apps/client/src/router.tsx`: `dashboardSearchSchema`, `sessionSearchSchema`, `agentsSearchSchema`, `activitySearchSchema`. Decision (per §6.3): explicit per-route merging instead of inheriting from `appShellRoute` for cleaner type ergonomics.

**Acceptance**:

- [ ] All 4 route schemas wrapped
- [ ] `pnpm typecheck` green
- [ ] `useSearch({ from: '/session' })` returns merged type at sample callsite

---

### Task 1.3: Create useDialogDeepLink hooks

**Size**: Medium
**Priority**: High
**Dependencies**: 1.1, 1.2
**Can run parallel with**: 1.4

Create `apps/client/src/layers/shared/model/use-dialog-deep-link.ts` containing:

- `DialogDeepLink<T>` interface
- `useSettingsDeepLink()` — full tab + section deep links
- `useAgentDialogDeepLink()` — exposes `agentPath`
- `useOpenAgentDialog()` — convenience opener requiring path
- `useTasksDeepLink()`, `useRelayDeepLink()`, `useMeshDeepLink()` — parameterless dialogs
- `useSimpleDialogDeepLink()` — internal helper for parameterless dialogs

`setTab` / `setSection` use `replace: true`; `open` / `close` use the default `push` so back-button works.

**Acceptance**:

- [ ] All exports documented with TSDoc
- [ ] `SettingsTab` and `AgentDialogTab` types resolved correctly
- [ ] `pnpm typecheck` + `pnpm lint` green

---

### Task 1.4: Create useDeepLinkScroll hook for sub-section scrolling

**Size**: Small
**Priority**: High
**Dependencies**: 1.1
**Can run parallel with**: 1.3

Create `apps/client/src/layers/shared/model/use-deep-link-scroll.ts`. The hook accepts `(section, onMatch?)`, sanitizes the section to alphanumeric+dash (security mitigation per §10), then `requestAnimationFrame`-defers a `document.querySelector('[data-section="..."]').scrollIntoView({ behavior: 'smooth', block: 'start' })`.

**Acceptance**:

- [ ] Sanitization regex applied before any DOM lookup
- [ ] TSDoc present
- [ ] `pnpm typecheck` + `pnpm lint` green

---

### Task 1.5: Export new schema and hooks from shared/model barrel

**Size**: Small
**Priority**: High
**Dependencies**: 1.3, 1.4
**Can run parallel with**: —

Add re-exports to `apps/client/src/layers/shared/model/index.ts` for `dialogSearchSchema`, `mergeDialogSearch`, `DialogSearch`, all five `useXxxDeepLink` hooks, `useOpenAgentDialog`, `DialogDeepLink`, and `useDeepLinkScroll`.

**Acceptance**:

- [ ] All seven exports added
- [ ] Barrel imports resolve at consumer sites
- [ ] `pnpm typecheck` + `pnpm lint` green

---

## Phase 2: Core Features

### Task 2.1: Add urlParam field to DialogContribution interface

**Size**: Small
**Priority**: High
**Dependencies**: 1.5
**Can run parallel with**: —

Extend `DialogContribution` in `apps/client/src/layers/shared/model/extension-registry.ts` with optional `urlParam?: 'settings' | 'agent' | 'tasks' | 'relay' | 'mesh'`.

**Acceptance**:

- [ ] Field added with TSDoc
- [ ] Existing contributions without `urlParam` still compile

---

### Task 2.2: Declare urlParam on DIALOG_CONTRIBUTIONS entries

**Size**: Small
**Priority**: High
**Dependencies**: 2.1
**Can run parallel with**: —

Update `apps/client/src/layers/widgets/app-layout/model/dialog-contributions.ts` to declare `urlParam` on settings/tasks/relay/mesh/agent contributions. `directory-picker` does NOT get a `urlParam`.

**Acceptance**:

- [ ] All five user-facing dialogs declare `urlParam`
- [ ] `directory-picker` left without `urlParam`

---

### Task 2.3: Refactor RegistryDialog to read URL+store dual signal

**Size**: Medium
**Priority**: High
**Dependencies**: 2.2
**Can run parallel with**: —

Update `RegistryDialog` in `apps/client/src/layers/widgets/app-layout/ui/DialogHost.tsx` so `open = storeOpen || urlSignal.isOpen` and `onOpenChange(false)` clears both. Add `useDialogUrlSignal(urlParam)` helper that calls all five `useXxxDeepLink` hooks unconditionally and switches on `urlParam` to return the right one.

**Hooks-in-a-switch caveat**: the five hooks are called unconditionally; only the result selection happens in the switch. Rules-of-hooks satisfied.

**Acceptance**:

- [ ] `open = storeOpen || urlSignal.isOpen`
- [ ] `onOpenChange(false)` clears both signals
- [ ] Five `useXxxDeepLink` hooks called unconditionally
- [ ] `pnpm typecheck` + `pnpm lint` green (no rules-of-hooks violations)

---

### Task 2.4: Wire SettingsDialog to read active tab from URL

**Size**: Medium
**Priority**: High
**Dependencies**: 2.3
**Can run parallel with**: 2.5

Replace the `useEffect`-based deep-link sync (lines 120-124) in `SettingsDialog.tsx` with:

```tsx
const { activeTab: urlTab, setTab } = useSettingsDeepLink();
const [localTab, setLocalTab] = useState<SettingsTab>(urlTab ?? 'appearance');
const activeTab = urlTab ?? localTab;
```

The dialog still has local state (so non-URL opens work), but URL takes precedence. Tab switches mirror to URL only when URL is the source.

**Acceptance**:

- [ ] `useEffect` sync removed
- [ ] Manual smoke: `?settings=tools` opens to Tools, store-based opens still work, back-button closes whole dialog

---

### Task 2.5: Wire AgentDialog to read active tab from URL

**Size**: Medium
**Priority**: High
**Dependencies**: 2.3
**Can run parallel with**: 2.4

Replace the adjust-state-during-render block (lines 53-59) in `AgentDialog.tsx` with the same pattern using `useAgentDialogDeepLink()`. Consume `agentPath` if needed for downstream rendering.

**Acceptance**:

- [ ] Adjust-state-during-render block removed
- [ ] Manual smoke: `?agent=identity&agentPath=/abs/path` opens to Identity for that project

---

### Task 2.6: Add data-section anchor and useDeepLinkScroll to ToolsTab

**Size**: Small
**Priority**: High
**Dependencies**: 2.4
**Can run parallel with**: —

Wrap the External MCP card in `ToolsTab.tsx` with `<div data-section="external-mcp">` and call `useDeepLinkScroll(section)` where `section` comes from `useSettingsDeepLink()`. Initial coverage: only `?settingsSection=external-mcp`.

**Acceptance**:

- [ ] `data-section="external-mcp"` wraps External MCP card
- [ ] Manual smoke: `?settings=tools&settingsSection=external-mcp` scrolls into view

---

### Task 2.7: Migrate command palette callsites to URL deep-link hooks

**Size**: Medium
**Priority**: High
**Dependencies**: 2.3
**Can run parallel with**: 2.8, 2.9, 2.10

Migrate `use-palette-actions.ts` and `use-global-palette.ts`:

- `setSettingsOpen(true)` / `openSettingsToTab('tools')` → `useSettingsDeepLink().open('tools')`
- `setTasksOpen(true)` → `useTasksDeepLink().open()`
- `setRelayOpen(true)` → `useRelayDeepLink().open()`
- `setMeshOpen(true)` → `useMeshDeepLink().open()`
- agent opens → `useOpenAgentDialog()(path, tab?)`

Hoist hook calls to the top of consuming React hooks/components if needed; rules-of-hooks must be satisfied.

**Acceptance**:

- [ ] No `setXxxOpen|openXxxToTab` calls remain in either file
- [ ] Palette commands open dialogs and update URL
- [ ] `command-palette-integration.test.tsx` still passes

---

### Task 2.8: Migrate feature promo dialogs to URL deep-link hooks

**Size**: Small
**Priority**: High
**Dependencies**: 2.3
**Can run parallel with**: 2.7, 2.9, 2.10

Migrate `RelayAdaptersDialog.tsx`, `SchedulesDialog.tsx`, `AgentChatDialog.tsx` to use `useSettingsDeepLink().open('tools')`, `useTasksDeepLink().open()`, and `useOpenAgentDialog()(path)` respectively.

**Acceptance**:

- [ ] All three promo dialogs migrated
- [ ] Manual smoke: each promo CTA opens dialog AND updates URL

---

### Task 2.9: Migrate sidebar and dashboard callsites to URL deep-link hooks

**Size**: Medium
**Priority**: High
**Dependencies**: 2.3
**Can run parallel with**: 2.7, 2.8, 2.10

Migrate:

- `dashboard-status/ui/SystemStatusRow.tsx` (health card click handlers)
- `session-list/ui/ConnectionsView.tsx`
- `session-list/ui/TasksView.tsx`
- `session-list/model/sidebar-contributions.ts`
- `session-list/model/use-task-notifications.ts`

For non-hook files (`sidebar-contributions.ts`), refactor the contribution shape so the consuming component constructs the callbacks with hooks at the top.

**Acceptance**:

- [ ] All five files migrated
- [ ] Manual smoke: each surface opens dialog AND updates URL
- [ ] `SidebarFooterBar.test.tsx`, `SessionSidebar.test.tsx` still pass

---

### Task 2.10: Migrate ChannelsTab, AgentRow, and MeshPanel callsites

**Size**: Small
**Priority**: High
**Dependencies**: 2.3
**Can run parallel with**: 2.7, 2.8, 2.9

Migrate:

- `agent-settings/ui/ChannelsTab.tsx:106` → `useSettingsDeepLink().open('channels')`
- `agents-list/ui/AgentRow.tsx` → `useOpenAgentDialog()(agent.path)`
- `mesh/ui/MeshPanel.tsx` → `useMeshDeepLink().open()`

**Acceptance**:

- [ ] All three files migrated
- [ ] `ChannelsTab.test.tsx` still passes

---

## Phase 3: Testing

### Task 3.1: Write unit tests for useDialogDeepLink hooks

**Size**: Large
**Priority**: High
**Dependencies**: 1.5
**Can run parallel with**: 3.2

Create `apps/client/src/layers/shared/model/__tests__/use-dialog-deep-link.test.tsx` with the full test list from spec §8.1 (10 cases for `useSettingsDeepLink`, 4 for `useAgentDialogDeepLink`, 2 for `useOpenAgentDialog`, 3 for the parameterless trio). Use a TanStack Router test wrapper backed by `createMemoryHistory`.

**Acceptance**:

- [ ] All cases passing
- [ ] `setTab`/`setSection` history-replacement asserted
- [ ] No flakes on three runs

---

### Task 3.2: Write unit tests for useDeepLinkScroll

**Size**: Medium
**Priority**: High
**Dependencies**: 1.5
**Can run parallel with**: 3.1

Create `apps/client/src/layers/shared/model/__tests__/use-deep-link-scroll.test.tsx` with cases from spec §8.2 plus a sanitization test. Mock `Element.prototype.scrollIntoView`, append `<div data-section>` into `document.body`, flush rAF.

**Acceptance**:

- [ ] All cases passing
- [ ] Sanitization covered

---

### Task 3.3: Update DialogHost.test.tsx with dual-signal RegistryDialog cases

**Size**: Medium
**Priority**: High
**Dependencies**: 2.3
**Can run parallel with**: 3.1, 3.2

Add five test cases (per §8.3) covering URL-only open, store-only open, both, dual-source close, and no-`urlParam` opt-out. Mount `<DialogHost />` inside a memory-history router wrapper.

**Acceptance**:

- [ ] All five cases passing
- [ ] Existing tests still pass

---

### Task 3.4: Update SettingsDialog and AgentDialog tests for URL hook

**Size**: Medium
**Priority**: High
**Dependencies**: 2.4, 2.5
**Can run parallel with**: 3.3

Update `SettingsDialog.test.tsx` and `AgentDialog.test.tsx` to drive the URL via a memory-history router wrapper instead of mocking `settingsInitialTab` / `agentDialogInitialTab`. Add new assertions for URL-driven tab opens.

**Acceptance**:

- [ ] Both files compile and pass

---

### Task 3.5: Verify migrated callsite tests still pass

**Size**: Medium
**Priority**: High
**Dependencies**: 2.7, 2.8, 2.9, 2.10
**Can run parallel with**: —

Run `command-palette-integration.test.tsx`, `ChannelsTab.test.tsx`, `SidebarFooterBar.test.tsx`, `SessionSidebar.test.tsx`. Adapt mocks to the new hook structure where they fail, but do not change test intent or skip tests.

**Acceptance**:

- [ ] All four test files pass
- [ ] `pnpm test -- --run` green for the whole client suite

---

### Task 3.6: Add Playwright E2E test for URL deep links and back-button behavior

**Size**: Medium
**Priority**: High
**Dependencies**: 2.6, 2.7
**Can run parallel with**: —

Create `apps/e2e/tests/dialog-deep-link.spec.ts` with the four tests from spec §8.4: open via URL, sub-section scroll, browser back closes dialog, palette open updates URL after migration. Add `data-testid="settings-dialog"` to the Settings dialog root if missing.

**Acceptance**:

- [ ] All four tests passing
- [ ] `data-testid="settings-dialog"` present
- [ ] `pnpm browsertest` exits 0

---

## Phase 4: Documentation & Verification

### Task 4.1: Document URL deep linking in contributing/architecture.md and state-management.md

**Size**: Small
**Priority**: Medium
**Dependencies**: 2.10
**Can run parallel with**: 4.2

Add a "Dialog deep linking via URL search params" section to `contributing/architecture.md` describing the dual-signal pattern, the per-dialog hook API, and example URLs. Update `contributing/state-management.md` to point at the new hooks instead of the deprecated `openSettingsToTab` etc.

**Acceptance**:

- [ ] New section in architecture.md
- [ ] state-management.md updated
- [ ] No stale references to `openSettingsToTab`/`openAgentDialogToTab`

---

### Task 4.2: Add changelog entry for URL-addressable dialogs

**Size**: Small
**Priority**: Medium
**Dependencies**: 2.10
**Can run parallel with**: 4.1

Add a changelog entry: "Settings, Tasks, Relay, Mesh, and Agent dialogs are now URL-addressable via search params. Share links like `?settings=tools` to deep-link teammates. Browser back closes dialogs; reload preserves dialog state." Include the privacy note about `agentPath`.

**Acceptance**:

- [ ] Entry added under Unreleased
- [ ] All five dialogs mentioned
- [ ] Privacy note included

---

### Task 4.3: Run final verification gate (typecheck/test/lint/browsertest + manual smokes)

**Size**: Small
**Priority**: High
**Dependencies**: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1, 4.2
**Can run parallel with**: —

Run all four automated checks (`pnpm typecheck`, `pnpm test -- --run`, `pnpm lint`, `pnpm browsertest`) plus six manual smokes from spec §12 Phase 8:

1. `?settings=tools` opens Settings to Tools
2. Palette open on `/agents` updates URL to `?settings=open`
3. Browser back closes deep-linked dialog
4. `?settings=tools&settingsSection=external-mcp` scrolls External MCP into view
5. `?agent=identity&agentPath=...` opens Agent dialog for that project
6. Store-based open via `setSettingsOpen(true)` still works without polluting URL

**Acceptance**:

- [ ] All four automated checks green
- [ ] All six manual smokes verified
- [ ] No regressions

---

## Critical Path

```
1.1 → 1.2 → 1.3 ─┐
            1.4 ─┴→ 1.5 → 2.1 → 2.2 → 2.3 → 2.4/2.5 → 2.6 → ... → 4.3
                                          ↘ 2.7/2.8/2.9/2.10 → 3.5 ↗
```

**Parallel batches:**

- Phase 1 leaves: `1.3` ‖ `1.4`
- Phase 2 dialog wires: `2.4` ‖ `2.5`
- Phase 2 callsite migrations: `2.7` ‖ `2.8` ‖ `2.9` ‖ `2.10`
- Phase 3 unit tests: `3.1` ‖ `3.2` ‖ `3.3` ‖ `3.4`
- Phase 4 docs: `4.1` ‖ `4.2`
