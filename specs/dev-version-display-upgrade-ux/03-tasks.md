# Task Breakdown: Dev Version Display & Upgrade UX Overhaul
Generated: 2026-03-10
Source: specs/dev-version-display-upgrade-ux/02-specification.md
Last Decompose: 2026-03-10

## Overview

Fix the dev-mode version bug where the server reports `0.0.0` and the status bar shows a false "Upgrade available" prompt. Add dev-mode detection with a DEV badge, skip npm registry fetches in dev, support per-version upgrade dismiss, and polish the Settings Server tab for both modes.

## Phase 1: Server — Dev Detection & Version Override

### Task 1.1: Add dev build detection and DORKOS_VERSION_OVERRIDE to version.ts
**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: None

**Technical Requirements**:
- Refactor `apps/server/src/lib/version.ts` to export `SERVER_VERSION` and `IS_DEV_BUILD`
- Version resolution priority: `DORKOS_VERSION_OVERRIDE` > `__CLI_VERSION__` > `package.json`
- Dev build detection: true when version matches `0.0.0` AND no override or CLI version injected
- Rename `DORKOS_VERSION` to `DORKOS_VERSION_OVERRIDE` in `apps/server/src/env.ts`
- Rename in `turbo.json` `globalPassThroughEnv`

**Implementation Steps**:
1. Replace `apps/server/src/lib/version.ts` with `resolveVersion()` and `checkDevBuild()` functions
2. Update env schema in `apps/server/src/env.ts`
3. Update `turbo.json` `globalPassThroughEnv` entry
4. Create `apps/server/src/lib/__tests__/version.test.ts`

**Acceptance Criteria**:
- [ ] `SERVER_VERSION` resolves with correct priority chain
- [ ] `IS_DEV_BUILD` is true for `0.0.0` without override
- [ ] `IS_DEV_BUILD` is false when override is set (even to `0.0.0`)
- [ ] Env var renamed in env.ts and turbo.json
- [ ] Tests written and passing

---

### Task 1.2: Guard update-checker to skip npm fetch in dev mode
**Size**: Small
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: None

**Technical Requirements**:
- Import `IS_DEV_BUILD` from `../../lib/version.js`
- Early return `null` when `IS_DEV_BUILD` is true
- No network requests in dev mode

**Implementation Steps**:
1. Add import and guard to `apps/server/src/services/core/update-checker.ts`
2. Write/extend tests in `apps/server/src/services/core/__tests__/update-checker.test.ts`

**Acceptance Criteria**:
- [ ] `getLatestVersion()` returns `null` without network request in dev mode
- [ ] Production behavior unchanged
- [ ] Tests written and passing

---

### Task 1.3: Add isDevMode to config route response and ServerConfigSchema
**Size**: Small
**Priority**: High
**Dependencies**: Task 1.1, Task 1.2
**Can run parallel with**: None

**Technical Requirements**:
- Import `IS_DEV_BUILD` in `apps/server/src/routes/config.ts`
- Add `isDevMode: IS_DEV_BUILD` to GET response
- Add `isDevMode` boolean to `ServerConfigSchema` in `packages/shared/src/schemas.ts`
- Update `latestVersion` description to mention dev mode

**Implementation Steps**:
1. Update config route GET handler
2. Update `ServerConfigSchema` in shared schemas
3. Verify TypeScript `ServerConfig` type includes new field

**Acceptance Criteria**:
- [ ] `GET /api/config` includes `isDevMode` boolean
- [ ] `ServerConfigSchema` includes `isDevMode` field
- [ ] `ServerConfig` type updated

---

## Phase 2: Client — Dev Mode UI

### Task 2.1: Extract version comparison utilities to shared lib
**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 2.2

**Technical Requirements**:
- Create `apps/client/src/layers/features/status/lib/version-compare.ts`
- Move `isNewer()` and `isFeatureUpdate()` from `VersionItem.tsx`
- Remove duplicate `isNewer()` from `ServerTab.tsx`
- Export both functions from status barrel `index.ts`
- ServerTab imports `isNewer` from `@/layers/features/status`

**Implementation Steps**:
1. Create `version-compare.ts` with both functions
2. Update `VersionItem.tsx` to import from `../lib/version-compare`
3. Update status `index.ts` barrel exports
4. Update `ServerTab.tsx` to import from `@/layers/features/status`
5. Remove duplicate local functions

**Acceptance Criteria**:
- [ ] No duplicate version comparison functions in client
- [ ] Barrel exports both functions
- [ ] All existing tests pass unchanged

---

### Task 2.2: Add DEV badge to VersionItem component
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.3
**Can run parallel with**: Task 2.1

**Technical Requirements**:
- Add `isDevMode` optional prop to `VersionItemProps`
- Render amber DEV badge when `isDevMode` is true
- Badge: `rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-amber-600 dark:text-amber-400`
- `aria-label="Development build"`
- Pass `isDevMode` from StatusLine using `serverConfig.isDevMode`

**Implementation Steps**:
1. Extend `VersionItemProps` interface
2. Add dev mode early return with DEV badge JSX
3. Update StatusLine to pass `isDevMode` prop
4. Write dev mode tests in `VersionItem.test.tsx`

**Acceptance Criteria**:
- [ ] DEV badge renders in dev mode
- [ ] No upgrade indicator in dev mode
- [ ] Correct aria-label
- [ ] StatusLine passes isDevMode
- [ ] Tests written and passing

---

### Task 2.3: Update Settings ServerTab for dev mode display
**Size**: Small
**Priority**: Medium
**Dependencies**: Task 1.3, Task 2.1
**Can run parallel with**: None

**Technical Requirements**:
- Wrap version/update section in `config.isDevMode` conditional
- Dev mode: show "Development Build" card with "Running from source" subtitle
- Production mode: existing version + update notice (unchanged)
- Uses `isNewer` imported from `@/layers/features/status`

**Implementation Steps**:
1. Add conditional around version display section in `ServerTab.tsx`
2. Verify amber styling consistency with existing update notice card

**Acceptance Criteria**:
- [ ] Dev mode shows "Development Build" card
- [ ] Production mode unchanged
- [ ] Consistent amber styling

---

## Phase 3: Upgrade Dismiss UX

### Task 3.1: Add dismissedUpgradeVersions to UserConfigSchema and config response
**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 1.3
**Can run parallel with**: None

**Technical Requirements**:
- Add `dismissedUpgradeVersions: z.array(z.string()).default(() => [])` to `UserConfigSchema.ui`
- Update `ui` section default to include the new field
- Add `dismissedUpgradeVersions` to `ServerConfigSchema`
- Read from `configManager.get('ui')` in config route GET handler
- Ensure PATCH `/api/config` can write to `ui.dismissedUpgradeVersions`

**Implementation Steps**:
1. Update `packages/shared/src/config-schema.ts` — ui section
2. Update `packages/shared/src/schemas.ts` — ServerConfigSchema
3. Update `apps/server/src/routes/config.ts` — GET response
4. Verify `USER_CONFIG_DEFAULTS` still parses correctly

**Acceptance Criteria**:
- [ ] Config schema includes dismissedUpgradeVersions
- [ ] API returns empty array by default
- [ ] PATCH can update dismiss list
- [ ] Types correct

---

### Task 3.2: Add dismiss support to VersionItem and wire in StatusLine
**Size**: Large
**Priority**: Medium
**Dependencies**: Task 2.2, Task 3.1
**Can run parallel with**: None

**Technical Requirements**:
- Add `isDismissed` and `onDismiss` props to `VersionItem`
- When dismissed, show plain version (no update indicator)
- Add "Dismiss this version" button in popover for both patch and feature updates
- StatusLine reads `dismissedUpgradeVersions` from `serverConfig`
- StatusLine sends `PATCH /api/config` via `transport.updateConfig()` on dismiss
- Invalidate config query after dismiss

**Implementation Steps**:
1. Extend `VersionItemProps` with `isDismissed` and `onDismiss`
2. Add dismissed logic to no-update early return
3. Add dismiss button to popover content
4. Add dismiss handler and state reading in StatusLine
5. Write dismiss tests in `VersionItem.test.tsx`

**Acceptance Criteria**:
- [ ] Dismissed state shows plain version
- [ ] Dismiss button in popover for both update types
- [ ] onDismiss called with correct version
- [ ] Dismiss persists via config PATCH
- [ ] Config query invalidated after dismiss
- [ ] Tests written and passing

---

## Phase 4: Documentation

### Task 4.1: Update env, config, and API documentation
**Size**: Small
**Priority**: Low
**Dependencies**: Task 3.1
**Can run parallel with**: None

**Technical Requirements**:
- Update `.env.example` — rename and redocument env var
- Update `contributing/configuration.md` — add `DORKOS_VERSION_OVERRIDE`
- Update `contributing/api-reference.md` — document `isDevMode` and `dismissedUpgradeVersions`
- Remove stale `DORKOS_VERSION` references

**Implementation Steps**:
1. Update `.env.example` comment block
2. Update configuration guide env var table
3. Update API reference with new response fields
4. Search for and remove old `DORKOS_VERSION` references in docs

**Acceptance Criteria**:
- [ ] .env.example updated
- [ ] Configuration guide updated
- [ ] API reference updated
- [ ] No stale env var references in docs

---

## Dependency Graph

```
Phase 1 (Server):
  1.1 ──→ 1.2 ──→ 1.3

Phase 2 (Client):
  2.1 ─────────────→ 2.3
  1.3 ──→ 2.2 ──────→ ↑
                      │
Phase 3 (Dismiss):    │
  1.3 ──→ 3.1 ──→ 3.2 (also depends on 2.2)

Phase 4 (Docs):
  3.1 ──→ 4.1
```

## Parallel Opportunities

- Tasks 2.1 and 2.2 can run in parallel (no dependency between them)
- Phase 1 tasks are sequential (each depends on the previous)
- Phase 3 depends on Phase 1 completion and Task 2.2

## Critical Path

1.1 → 1.2 → 1.3 → 2.2 → 3.2

This is the longest chain and determines minimum completion time.
