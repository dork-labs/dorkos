# Task Breakdown: Agent Dialog Channels Tab — Correctness & Architecture Cleanup

Generated: 2026-04-06
Source: specs/agent-channels-tab-01-correctness/02-specification.md
Last Decompose: 2026-04-06

## Overview

This spec fixes two user-visible bugs in the agent-settings Channels tab and cleans up render-path inefficiencies:

1. **Bug: "Claude Code" appears in the Connect to Channel picker** — The `claude-code` adapter (category: `internal`) is not filtered out in the agent-facing ChannelsTab, causing users to see a nonsensical "Claude Code" channel option.
2. **Bug: "Set up a new channel" drops the user out of context** — Clicking "Set up a new channel..." closes the AgentDialog and opens Settings, losing the user's place entirely.
3. **Code smells** — Unmemoized Map, stale useCallback deps, three redundant accessor functions, duplicated filter logic.

**Blast radius:** 5 files modified, 2 files created. Zero schema changes. Zero server changes.

---

## Phase 1: Foundation

### Task 1.1: Create useExternalAdapterCatalog shared hook and ADAPTER_CATEGORY_INTERNAL constant

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: None

**Technical Requirements**:

- New file: `apps/client/src/layers/entities/relay/model/use-external-adapter-catalog.ts`
- Export `ADAPTER_CATEGORY_INTERNAL: AdapterCategory = 'internal'` typed constant
- Export `useExternalAdapterCatalog(enabled?)` hook that composes `useAdapterCatalog` and filters with `useMemo`
- Add barrel exports to `apps/client/src/layers/entities/relay/index.ts`

**Implementation Steps**:

1. Create the new hook file with `useMemo`-wrapped filter on `query.data`
2. Add exports to the entity barrel
3. Run `pnpm typecheck`

**Acceptance Criteria**:

- [ ] Hook exists and composes `useAdapterCatalog` (not a separate `useQuery`)
- [ ] Filter uses typed constant, not string literal
- [ ] `data` is memoized on `query.data` identity
- [ ] Both symbols exported from barrel
- [ ] TSDoc on both exports
- [ ] `pnpm typecheck` passes

---

### Task 1.2: Add unit tests for useExternalAdapterCatalog hook

**Size**: Small
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: None

**Technical Requirements**:

- New file: `apps/client/src/layers/entities/relay/model/__tests__/use-external-adapter-catalog.test.ts`
- 4 tests: filter, stability, disabled, constant export

**Implementation Steps**:

1. Create test file with `renderHook` from `@testing-library/react`
2. Mock `useAdapterCatalog` from the sibling module
3. Write all 4 tests
4. Run and confirm passing

**Acceptance Criteria**:

- [ ] Filter test includes `category: 'internal'` entry and asserts exclusion
- [ ] Stability test uses `toBe` (reference equality)
- [ ] Disabled test passes `false` and asserts `data` is `[]`
- [ ] Constant test asserts value is `'internal'`
- [ ] All 4 tests pass

---

## Phase 2: Core Fixes

### Task 2.1: Migrate Settings ChannelsTab to use shared useExternalAdapterCatalog hook

**Size**: Small
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 2.2

**Technical Requirements**:

- Modify: `apps/client/src/layers/features/settings/ui/ChannelsTab.tsx`
- Replace `useAdapterCatalog` import with `useExternalAdapterCatalog`
- Delete the inline `useMemo` filter
- Keep `externalCatalog` variable name (no downstream changes)

**Implementation Steps**:

1. Update imports to use `useExternalAdapterCatalog` and `useRelayEnabled` from single import
2. Replace hook call and remove inline filter
3. Verify no string literal `'internal'` remains
4. Run typecheck and existing tests

**Acceptance Criteria**:

- [ ] `useAdapterCatalog` no longer imported in this file
- [ ] Inline `useMemo` filter deleted
- [ ] No `'internal'` string literal in file
- [ ] `pnpm typecheck` passes
- [ ] Existing tests pass unchanged

---

### Task 2.2: Refactor ChannelPicker to accept catalog and setup callback as props

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 2.1

**Technical Requirements**:

- Modify: `apps/client/src/layers/features/agent-settings/ui/ChannelPicker.tsx`
- Remove `useAdapterCatalog` and `useRelayEnabled` imports
- Accept `catalog: CatalogEntry[]` and `onRequestSetup: (manifest) => void` as props
- Replace `onSetupNewChannel` with `onRequestSetup`
- Add "Available to set up" section in popover
- Compute `configuredChannels` and `availableToSetup` with `useMemo`

**Implementation Steps**:

1. Rewrite component with new props interface
2. Add two-section popover structure (configured + available)
3. Remove all entity-layer hook imports
4. Handle empty state when both sections are empty

**Acceptance Criteria**:

- [ ] No imports from `@/layers/entities/relay`
- [ ] Accepts `catalog` and `onRequestSetup` props
- [ ] Two popover sections with `border-t` divider
- [ ] "Available to set up" only renders when qualifying entries exist
- [ ] Empty state shows "No channels available"
- [ ] Popover closes before calling callbacks

---

### Task 2.3: Rewrite agent-settings ChannelsTab with shared hook, memoized Map, collapsed accessors, and inline wizard

**Size**: Large
**Priority**: High
**Dependencies**: Task 1.1, Task 2.2
**Can run parallel with**: None

**Technical Requirements**:

- Modify: `apps/client/src/layers/features/agent-settings/ui/ChannelsTab.tsx`
- Swap `useAdapterCatalog` to `useExternalAdapterCatalog`
- Memoize `adapterDisplayByInstanceId` Map with `useMemo`
- Collapse 3 `resolve*` functions into single `resolveAdapterDisplay`
- Hoist `wizardState` and render `<AdapterSetupWizard>` inline
- Remove `useAgentDialogDeepLink`, `useSettingsDeepLink`, `handleSetupNewChannel`
- Pass filtered catalog to `ChannelPicker` as prop

**Implementation Steps**:

1. Replace entire file with new implementation
2. Verify no imports from `@/layers/shared/model` for dialog navigation
3. Verify `AdapterSetupWizard` import from `@/layers/features/relay` (allowed by FSD)
4. Run `pnpm typecheck`

**Acceptance Criteria**:

- [ ] No `useAgentDialogDeepLink` or `useSettingsDeepLink` imports
- [ ] No `requestAnimationFrame` calls
- [ ] Map wrapped in `useMemo` keyed on `externalCatalog`
- [ ] Single `resolveAdapterDisplay` returning `{ state, name, errorMessage }`
- [ ] `handleEdit` dep list contains only `resolveAdapterDisplay`
- [ ] `<AdapterSetupWizard>` rendered inline with `wizardState`
- [ ] `<ChannelPicker>` receives `catalog` and `onRequestSetup` props
- [ ] `pnpm typecheck` passes

---

## Phase 3: Testing

### Task 3.1: Update ChannelsTab test suite for new hook, inline wizard, and removed cross-dialog flow

**Size**: Medium
**Priority**: High
**Dependencies**: Task 2.3
**Can run parallel with**: None

**Technical Requirements**:

- Modify: `apps/client/src/layers/features/agent-settings/ui/__tests__/ChannelsTab.test.tsx`
- Rename mock to `mockUseExternalAdapterCatalog`
- Delete `@/layers/shared/model` mock block
- Add `@/layers/features/relay` mock for `AdapterSetupWizard`
- Delete "setup new channel navigation" test
- Add 3 new tests: filter regression guard, inline wizard, no cross-dialog navigation

**Implementation Steps**:

1. Update all mock references
2. Delete stale test and mocks
3. Add new test cases
4. Run and confirm all pass

**Acceptance Criteria**:

- [ ] Mock renamed to `mockUseExternalAdapterCatalog`
- [ ] `@/layers/shared/model` mock deleted
- [ ] `AdapterSetupWizard` mocked
- [ ] Old cross-dialog test deleted
- [ ] 3 new tests pass
- [ ] All existing tests continue to pass

---

### Task 3.2: Run full typecheck, lint, and client test suite

**Size**: Small
**Priority**: High
**Dependencies**: Task 3.1
**Can run parallel with**: None

**Technical Requirements**:

- Run `pnpm typecheck` (zero errors)
- Run `pnpm lint` (zero errors)
- Run `pnpm vitest run apps/client` (zero failures)

**Implementation Steps**:

1. Run each command and fix any issues
2. Trace failures back to the specific task that caused them

**Acceptance Criteria**:

- [ ] `pnpm typecheck` passes with zero errors
- [ ] `pnpm lint` passes with zero errors
- [ ] `pnpm vitest run apps/client` passes with zero failures
- [ ] No warnings for unused imports in modified files

---

## Dependency Graph

```
1.1 (Create hook)
 ├── 1.2 (Hook tests)
 ├── 2.1 (Settings ChannelsTab migration) ─┐
 └── 2.2 (ChannelPicker refactor) ─────────┤
                                            └── 2.3 (Agent ChannelsTab rewrite)
                                                 └── 3.1 (Test updates)
                                                      └── 3.2 (Full validation)
```

## Parallel Opportunities

- **Tasks 2.1 and 2.2** can run in parallel (both depend only on 1.1, neither depends on each other)

## Critical Path

1.1 → 2.2 → 2.3 → 3.1 → 3.2
