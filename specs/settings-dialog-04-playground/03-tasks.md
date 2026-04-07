# Task Breakdown: Dev Playground Settings Page

Generated: 2026-04-07
Source: specs/settings-dialog-04-playground/02-specification.md

## Overview

Add a `/dev/settings` page to the dev playground that comprehensively showcases the Settings dialog system: full `SettingsDialog` and `AgentDialog`, every individual settings tab in isolation, the mobile drill-in pattern, loading and empty states for data-driven tabs, and the underlying primitives (`FieldCard`, `SettingRow`). Six `<PlaygroundSection>` blocks, six search-index entries.

The implementation is purely additive — 4 new files plus minor edits to 3 existing playground wiring files. No app behavior changes, no new dependencies. The whole spec is gated to the `dev/` surface.

### Phasing

| Phase | Theme                             | Tasks              |
| ----- | --------------------------------- | ------------------ |
| 1     | Foundation — typed mock data      | 1.1                |
| 2     | Foundation — registry wiring      | 2.1, 2.2, 2.3, 2.4 |
| 3     | Showcases — implementation        | 3.1, 3.2           |
| 4     | Verification — automated + manual | 4.1, 4.2, 4.3      |

### Critical path

1.1 → (parallel with 2.1) → 2.2 → 2.3 → 2.4 → 3.1 → 3.2 → 4.1 → 4.2 → 4.3

### Key finding from grounding

The spec was written assuming `ServerTab` takes `config`/`isLoading` props and `AdvancedTab` takes `onResetComplete`/`onRestartComplete` callbacks. **All eight settings tabs are already parameterless** in the current codebase — the post-`settings-dialog-02-tabbed-primitive` migration has already landed. Task 3.1 reflects this and uses `MockedQueryProvider` (or its absence) to control loaded vs. empty branches instead of prop-driven variants.

---

## Phase 1: Foundation — Mock Data

### Task 1.1: Create settings-mock-data.ts with typed mock data

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 2.1

**Technical Requirements**:

- New file `apps/client/src/dev/showcases/settings-mock-data.ts` (~70 lines)
- Three exports: `MOCK_SERVER_CONFIG: ServerConfig`, `MOCK_AGENT_MANIFEST: AgentManifest`, `MOCK_MESH_AGENTS`
- Must import the real Zod-derived types from `@dorkos/shared/types` and `@dorkos/shared/mesh-schemas`
- No `any`, no `as` casts — TypeScript enforces shape correctness
- TSDoc on every export

**Implementation Steps**:

1. Create the file with the three typed literal exports listed in spec section 6.4
2. Run `pnpm typecheck` immediately
3. Fill in any required fields the type system flags as missing (the `ServerConfig` schema is large and likely has fields not enumerated in the spec)
4. Add TSDoc on each export describing which showcases consume it

**Acceptance Criteria**:

- [ ] File exists at the specified path
- [ ] All three exports are typed against the real schemas (no escape hatches)
- [ ] `pnpm typecheck` passes
- [ ] Each export has TSDoc
- [ ] No imports from `@/layers/features/*`

---

## Phase 2: Foundation — Registry Wiring

### Task 2.1: Create SETTINGS_SECTIONS registry entries

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1

**Technical Requirements**:

- New file `apps/client/src/dev/sections/settings-sections.ts` (~50 lines)
- Exports `SETTINGS_SECTIONS: PlaygroundSection[]` with exactly six entries
- IDs: `full-settings-dialog`, `full-agent-dialog`, `individual-tabs`, `mobile-drill-in`, `loading-empty-states`, `settings-primitives`
- Categories: `Dialogs`, `Tabs`, `Responsive`, `States`, `Primitives`
- Pattern reference: `apps/client/src/dev/sections/components-sections.ts`

**Implementation Steps**:

1. Copy the structure from `components-sections.ts`
2. Add the six entries from spec section 6.6
3. Each entry sets `page: 'settings'` (will fail to typecheck until task 2.2 lands — coordinate landing order)

**Acceptance Criteria**:

- [ ] Six entries with the IDs above
- [ ] All IDs are unique within the file (cross-registry uniqueness verified by `playground-registry.test.ts`)
- [ ] No spaces in any ID
- [ ] Keywords on `individual-tabs` include all eight tab names so search can find them

---

### Task 2.2: Wire SETTINGS_SECTIONS into playground-registry.ts

**Size**: Small
**Priority**: High
**Dependencies**: 2.1
**Can run parallel with**: None

**Technical Requirements**:

- Modify `apps/client/src/dev/playground-registry.ts`
- Add `'settings'` to the `Page` union (currently 14 strings)
- Re-export `SETTINGS_SECTIONS`
- Import under alias and append to `PLAYGROUND_REGISTRY`

**Implementation Steps**:

1. Add `| 'settings'` to the end of the `Page` union
2. Add `export { SETTINGS_SECTIONS } from './sections/settings-sections';`
3. Add `import { SETTINGS_SECTIONS as settings } from './sections/settings-sections';`
4. Append `...settings` to `PLAYGROUND_REGISTRY`

**Acceptance Criteria**:

- [ ] All three changes applied
- [ ] `pnpm typecheck` passes
- [ ] `pnpm vitest run apps/client/src/dev/__tests__/playground-registry.test.ts` passes

---

### Task 2.3: Add Settings PageConfig to playground-config.ts

**Size**: Small
**Priority**: High
**Dependencies**: 2.2
**Can run parallel with**: None

**Technical Requirements**:

- Modify `apps/client/src/dev/playground-config.ts`
- Import `Settings as SettingsIcon` from `lucide-react` (alias to avoid clashing with `Settings2`)
- Import `SETTINGS_SECTIONS` from `./playground-registry`
- Add a new entry to `PAGE_CONFIGS` in the `app-shell` group

**Implementation Steps**:

1. Update the lucide-react import block to include `Settings as SettingsIcon`
2. Update the `./playground-registry` import block to include `SETTINGS_SECTIONS`
3. Append the new `PageConfig` to the array (last in `app-shell` group)

**Acceptance Criteria**:

- [ ] New entry has `id: 'settings'`, `group: 'app-shell'`, `path: 'settings'`, `sections: SETTINGS_SECTIONS`, `icon: SettingsIcon`
- [ ] `pnpm typecheck` passes
- [ ] Sidebar will show "Settings" under "App Shell" (verified once Phase 3 lands)

---

### Task 2.4: Create empty SettingsPage and wire into DevPlayground

**Size**: Small
**Priority**: High
**Dependencies**: 2.1, 2.2, 2.3
**Can run parallel with**: None

**Technical Requirements**:

- New file `apps/client/src/dev/pages/SettingsPage.tsx` (~20 lines)
- Modify `apps/client/src/dev/DevPlayground.tsx` to register the page
- Page renders an empty `<PlaygroundPageLayout>` (Phase 3 fills it)

**Implementation Steps**:

1. Create `SettingsPage.tsx` following `ComponentsPage.tsx` pattern, with `{/* Showcases added in Phase 3 */}` as the body
2. Add `import { SettingsPage } from './pages/SettingsPage';` to `DevPlayground.tsx`
3. Add `settings: SettingsPage` to the `PAGE_COMPONENTS` lookup

**Acceptance Criteria**:

- [ ] `/dev/settings` shows the page header and TOC sidebar without errors
- [ ] No console errors
- [ ] All existing playground tests still pass

---

## Phase 3: Showcases — Implementation

### Task 3.1: Create SettingsShowcases.tsx with all six sections

**Size**: Large
**Priority**: High
**Dependencies**: 1.1, 2.4
**Can run parallel with**: None

**Technical Requirements**:

- New file `apps/client/src/dev/showcases/SettingsShowcases.tsx` (~280 lines)
- Six section components rendered in order: `FullSettingsDialogSection`, `FullAgentDialogSection`, `IndividualTabsSection`, `MobileDrillInSection`, `LoadingEmptyStatesSection`, `PrimitivesSection`
- Two helpers: `MockedQueryProvider` and `TabShell`
- Imports tabs from internal paths (`@/layers/features/settings/ui/tabs/AppearanceTab` etc.) — the feature barrels do not re-export individual tabs
- All tabs are parameterless (verified) — the spec's prop-driven loading variants are obsolete

**Critical Note**:

The spec's `ServerTab(config, isLoading)` and `AdvancedTab(onResetComplete, onRestartComplete)` signatures DO NOT MATCH the current code. All eight tabs are now parameterless. The task description in `03-tasks.json` has the corrected implementation with full code blocks.

**Implementation Steps**:

1. Create the file with the imports listed in the JSON task description
2. Define `MockedQueryProvider` — fresh `QueryClient` per mount, prepopulated with `MOCK_SERVER_CONFIG` under `['config']` and `MOCK_MESH_AGENTS` under `['mesh', 'agents']`
3. **Verify query keys** by grepping the settings tabs for `useQuery` calls — keys must match exactly or the prepopulated data is invisible
4. Define `TabShell` — bare `NavigationLayout` with a single panel
5. Implement each of the six sections per the JSON task description
6. Wrap data-driven tabs (`ServerTab`, `ToolsTab`, `ChannelsTab`, `AgentsTab`) in `MockedQueryProvider` for the `IndividualTabsSection`
7. Leave them unwrapped in `LoadingEmptyStatesSection` to demonstrate the empty-state branches
8. Add TSDoc on the exported `SettingsShowcases` function

**Acceptance Criteria**:

- [ ] Each `<PlaygroundSection>`'s `id` matches an entry in `SETTINGS_SECTIONS`
- [ ] No tabs are passed props
- [ ] `MockedQueryProvider` keys align with the actual `queryKey` arrays in the codebase
- [ ] `pnpm typecheck` and `pnpm lint` pass
- [ ] File stays under 300 lines (or extracts helpers into a sibling file if it exceeds)

---

### Task 3.2: Wire SettingsShowcases into SettingsPage

**Size**: Small
**Priority**: High
**Dependencies**: 3.1
**Can run parallel with**: None

**Technical Requirements**:

- Modify `apps/client/src/dev/pages/SettingsPage.tsx`
- Import `SettingsShowcases` from `../showcases/SettingsShowcases`
- Render `<SettingsShowcases />` as the only child of `<PlaygroundPageLayout>`

**Implementation Steps**:

1. Replace the `{/* Showcases added in Phase 3 */}` placeholder with `<SettingsShowcases />`
2. Add the import at the top of the file

**Acceptance Criteria**:

- [ ] Visiting `/dev/settings` shows all six sections rendered in order
- [ ] TOC sidebar lists the six sections under their categories
- [ ] `pnpm typecheck` passes

---

## Phase 4: Verification

### Task 4.1: Run automated checks (typecheck, lint, tests)

**Size**: Small
**Priority**: High
**Dependencies**: 3.2
**Can run parallel with**: None

**Technical Requirements**:

Run the four commands from spec section 8.3:

```bash
pnpm typecheck
pnpm test -- --run
pnpm vitest run apps/client/src/dev/__tests__
pnpm lint
```

**Implementation Steps**:

1. Run each command in order
2. For each failure, identify root cause and fix in the offending file (do NOT bypass with `any` or `eslint-disable` unless the JSON task description explicitly allows it for deep-import paths)
3. Re-run after each fix until all four commands exit clean

**Acceptance Criteria**:

- [ ] All four commands exit with code 0
- [ ] No new test failures
- [ ] No new lint violations
- [ ] No `any` casts added

---

### Task 4.2: Manual smoke checklist for /dev/settings

**Size**: Medium
**Priority**: High
**Dependencies**: 4.1
**Can run parallel with**: None

**Technical Requirements**:

- Run `pnpm dev` (Vite + Express)
- Open `http://localhost:6241/dev/settings` (dev port convention)
- Walk through all 30+ checklist items in spec section 8.4

**Implementation Steps**:

1. Start the dev server
2. Navigate to `/dev/settings`
3. Verify each checklist item from the JSON task description (sidebar nav, page header, all six sections with their interactive behaviors, viewport toggle, search palette discovery)
4. Capture a screenshot for the PR description
5. Note any console errors or visual regressions and fix them before declaring done

**Acceptance Criteria**:

- [ ] Every item in the checklist passes
- [ ] No console errors or warnings
- [ ] Screenshot captured

---

### Task 4.3: Add changelog entry for Settings playground page

**Size**: Small
**Priority**: Low
**Dependencies**: 4.2
**Can run parallel with**: None

**Technical Requirements**:

- Locate the project changelog file
- Add a one-line "Internal" entry under the next pending release

**Implementation Steps**:

1. `ls CHANGELOG.md docs/CHANGELOG.md apps/site/CHANGELOG.md 2>/dev/null` to find the file
2. Add the entry in the existing style: "Dev playground gains a Settings page covering dialogs, tabs, primitives, and responsive states"
3. If no changelog file exists, document that fact in the PR description and skip the task — do not create a new changelog file

**Acceptance Criteria**:

- [ ] Changelog updated, OR PR description notes no changelog exists
- [ ] No version bump

---

## Parallel Execution Opportunities

- Tasks 1.1 and 2.1 are independent (mock data and registry entries) and can run in parallel as the very first batch
- All other tasks have strict sequential dependencies because each one builds on the previous file

## File Inventory

### New files (4)

- `apps/client/src/dev/showcases/settings-mock-data.ts` (Task 1.1)
- `apps/client/src/dev/sections/settings-sections.ts` (Task 2.1)
- `apps/client/src/dev/pages/SettingsPage.tsx` (Task 2.4, updated in Task 3.2)
- `apps/client/src/dev/showcases/SettingsShowcases.tsx` (Task 3.1)

### Modified files (3)

- `apps/client/src/dev/playground-registry.ts` (Task 2.2)
- `apps/client/src/dev/playground-config.ts` (Task 2.3)
- `apps/client/src/dev/DevPlayground.tsx` (Task 2.4)

### Optional modifications (1)

- `CHANGELOG.md` or equivalent (Task 4.3, conditional)
