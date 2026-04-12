# Task Breakdown: Deprecate `session.canvas` Extension Slot

**Spec**: `specs/deprecate-session-canvas-slot/02-specification.md`
**Generated**: 2026-04-12
**Mode**: Full decomposition

## Overview

This is a small, low-risk cleanup that removes the orphaned `session.canvas` extension slot and replaces it with `right-panel` across 11 source files and 5 test files. The spec calls for a single atomic commit; the tasks below are grouped logically for parallel execution where possible.

---

## Phase 1: Public API & Registry

### Task 1.1 — Replace session.canvas with right-panel in ExtensionPointId and extension registry

**Size**: Medium | **Priority**: High | **Dependencies**: None | **Parallel with**: 1.2, 1.3, 1.5

Update the public extension API type and the client-side extension registry:

**Files**:

- `packages/extension-api/src/extension-api.ts` — Replace `'session.canvas'` with `'right-panel'` in the `ExtensionPointId` union type
- `apps/client/src/layers/shared/model/extension-registry.ts` — Three changes:
  - Remove `SESSION_CANVAS: 'session.canvas'` from `SLOT_IDS`
  - Delete the `SessionCanvasContribution` interface entirely
  - Remove `'session.canvas': SessionCanvasContribution` from `SlotContributionMap`
- `apps/client/src/layers/shared/model/index.ts` — Remove the `type SessionCanvasContribution` re-export

**Acceptance**: `ExtensionPointId` includes `'right-panel'`, no `session.canvas` or `SessionCanvasContribution` references remain in these files, `pnpm tsc --noEmit` passes.

---

### Task 1.2 — Replace session.canvas with right-panel in server-side files

**Size**: Small | **Priority**: High | **Dependencies**: None | **Parallel with**: 1.1, 1.3, 1.5

Update all server-side references:

**Files**:

- `apps/server/src/services/extensions/extension-templates.ts` — Replace `session.canvas` with `right-panel` in 4 template comment lines (203, 249, 288, 348)
- `apps/server/src/services/extensions/extension-test-harness.ts` — Replace `'session.canvas'` with `'right-panel'` in `ALL_EXTENSION_SLOTS` array
- `apps/server/src/services/runtimes/claude-code/mcp-tools/extension-tools.ts` — Replace `'session.canvas'` with `'right-panel'` in the MCP tool type definition string

**Acceptance**: `grep -r 'session\.canvas' apps/server/src/ --include='*.ts'` returns zero results (excluding test files), `pnpm tsc --noEmit` passes.

---

### Task 1.3 — Replace session.canvas with right-panel in client main.tsx and API factory

**Size**: Small | **Priority**: High | **Dependencies**: None | **Parallel with**: 1.1, 1.2, 1.5

Update client entry point and API factory:

**Files**:

- `apps/client/src/main.tsx` — Replace `'session.canvas'` with `'right-panel'` in the `availableSlots` Set
- `apps/client/src/layers/features/extensions/model/extension-api-factory.ts` — Replace `case 'session.canvas'` with `case 'right-panel'` and update the return shape to match `RightPanelContribution`: `{ ...base, component, title: id, icon: undefined as unknown as LucideIcon, visibleWhen: undefined }`

**Acceptance**: No `session.canvas` in either file, new `case 'right-panel'` returns correct shape, `pnpm tsc --noEmit` passes.

---

### Task 1.4 — Update all test files from session.canvas to right-panel

**Size**: Small | **Priority**: High | **Dependencies**: 1.1, 1.2, 1.3 | **Parallel with**: None

Update 5 test files (8 total occurrences):

| Test File                        | Line(s)     | Change                                                                   |
| -------------------------------- | ----------- | ------------------------------------------------------------------------ |
| `extension-tools.test.ts`        | 63          | `'session.canvas': 0` → `'right-panel': 0`                               |
| `extension-manager-test.test.ts` | 129         | `toHaveProperty('session.canvas')` → `toHaveProperty('right-panel')`     |
| `extension-tools-phase2.test.ts` | 38, 92, 197 | Three `session.canvas` → `right-panel` replacements                      |
| `extension-registry.test.ts`     | 77          | `getContributions('session.canvas')` → `getContributions('right-panel')` |
| `extension-api-factory.test.ts`  | 50          | `'session.canvas'` → `'right-panel'` in mock availableSlots              |

**Acceptance**: `grep -r 'session\.canvas' --include='*.test.ts' apps/` returns zero results, all 5 test suites pass.

---

### Task 1.5 — Remove session.canvas row from marketplace-dev SKILL.md

**Size**: Small | **Priority**: Medium | **Dependencies**: None | **Parallel with**: 1.1, 1.2, 1.3

**File**: `.claude/skills/marketplace-dev/SKILL.md`

Delete the `session.canvas` row from the Extension API slots table (line ~314):

```
| `session.canvas`        | Canvas area in sessions (deprecated — use `right-panel`) |
```

**Acceptance**: `grep 'session.canvas' .claude/skills/marketplace-dev/SKILL.md` returns zero results, `right-panel` row is still present.

---

## Final Verification

After all tasks complete, run:

```bash
# No session.canvas references in source files
grep -r 'session\.canvas' --include='*.ts' --include='*.tsx' apps/ packages/
# Should return zero results

# No SessionCanvasContribution references in source files
grep -r 'SessionCanvasContribution' --include='*.ts' --include='*.tsx' apps/ packages/
# Should return zero results

# Type-check
pnpm tsc --noEmit

# All tests pass
pnpm test -- --run
```

## Dependency Graph

```
1.1 (API type + registry)  ──┐
1.2 (server files)         ──┼── 1.4 (tests)
1.3 (client main + factory)──┘
1.5 (SKILL.md docs)        ── independent
```

Tasks 1.1, 1.2, 1.3, and 1.5 can run in parallel. Task 1.4 (tests) depends on 1.1-1.3 completing first since the test assertions must match the new source types.
