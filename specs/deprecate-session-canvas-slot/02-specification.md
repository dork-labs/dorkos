---
slug: deprecate-session-canvas-slot
spec: 239
status: draft
created: 2026-04-12
parent: shell-level-right-panel
---

# Deprecate `session.canvas` Extension Slot

## Status

Draft

## Authors

- Claude (spec author), 2026-04-12

## Overview

Remove the orphaned `session.canvas` extension slot from all runtime code, types, constants, templates, and tests. Replace it with `right-panel` in the `ExtensionPointId` type and all places where the slot list is enumerated. This completes the migration started in spec #237 (shell-level-right-panel).

## Background / Problem Statement

The `session.canvas` extension slot was introduced as part of the extension platform (spec series ext-platform-01 through -04). It was intended for custom canvas content renderers, but was never fully implemented by any third-party extension. The only consumer was the built-in canvas, which registered a `SessionCanvasContribution` with `contentType: 'extension'`.

Spec #237 (shell-level-right-panel) migrated the canvas from `session.canvas` to a `right-panel` contribution registered in `init-extensions.ts`. The `RightPanelContribution` interface and `RIGHT_PANEL` slot ID were added to the extension registry, and the `RightPanelContainer` component now renders all right-panel contributions.

However, `session.canvas` was left behind in 8 runtime files and 6 test files. It appears in the `ExtensionPointId` union type (the public extension API contract), slot constants, templates, the API factory switch, and MCP tool descriptions. Meanwhile, `right-panel` is missing from `ExtensionPointId`, `availableSlots` in main.tsx, the extension test harness, and the MCP tool slot type — so it's only half-integrated.

This spec completes the swap: remove `session.canvas` everywhere, add `right-panel` where missing.

## Goals

- Remove all runtime references to `session.canvas` from `.ts`/`.tsx` source files
- Add `right-panel` to `ExtensionPointId` (the public API type in `@dorkos/extension-api`)
- Add `right-panel` to `availableSlots`, the test harness, and the MCP tool slot type
- Add a `case 'right-panel'` to the extension API factory so extensions can register right-panel contributions
- Update all test assertions from `session.canvas` to `right-panel`
- Remove the `SessionCanvasContribution` interface (no longer needed)
- Remove the deprecated `session.canvas` row from the marketplace-dev SKILL.md

## Non-Goals

- **Do not** remove or deprecate the `openCanvas(content)` method on `ExtensionAPI` — it works via UI commands (`open_canvas`), not the slot system, and is functionally independent
- **Do not** touch canvas Zustand state (`canvasOpen`, `canvasContent`, `setCanvasOpen` in `app-store-canvas.ts`) — still needed for per-session content persistence
- **Do not** modify `ui-action-dispatcher.ts` or `ui-tools.ts` — the `open_canvas`/`update_canvas`/`close_canvas` UI commands are still valid
- **Do not** modify `use-canvas-persistence.ts` — still used by SessionPage
- **Do not** modify historical spec files (`specs/ext-platform-*`) — they are records of past decisions
- **Do not** modify the `contributing/extension-authoring.md` doc — it was already updated in the prior commit

## Technical Dependencies

- None. All required interfaces (`RightPanelContribution`, `RIGHT_PANEL` slot ID) already exist in the codebase.
- No external libraries involved.
- No database or migration changes.

## Detailed Design

### 1. `packages/extension-api/src/extension-api.ts`

**Current** (line 5-13):

```typescript
export type ExtensionPointId =
  | 'sidebar.footer'
  | 'sidebar.tabs'
  | 'dashboard.sections'
  | 'header.actions'
  | 'command-palette.items'
  | 'dialog'
  | 'settings.tabs'
  | 'session.canvas';
```

**After**:

```typescript
export type ExtensionPointId =
  | 'sidebar.footer'
  | 'sidebar.tabs'
  | 'dashboard.sections'
  | 'header.actions'
  | 'command-palette.items'
  | 'dialog'
  | 'settings.tabs'
  | 'right-panel';
```

### 2. `apps/client/src/main.tsx`

**Current** (line 118-126):

```typescript
  [
    'sidebar.footer',
    'sidebar.tabs',
    'dashboard.sections',
    'header.actions',
    'command-palette.items',
    'dialog',
    'settings.tabs',
    'session.canvas',
  ] as const) as ExtensionAPIDeps['availableSlots'],
```

**After**: Replace `'session.canvas'` with `'right-panel'`.

### 3. `apps/client/src/layers/shared/model/extension-registry.ts`

Three removals:

**a) `SLOT_IDS` constant** (line 17): Remove `SESSION_CANVAS: 'session.canvas'`. Keep `RIGHT_PANEL: 'right-panel'` (line 18).

**b) `SessionCanvasContribution` interface** (lines 96-100): Delete entirely.

```typescript
// DELETE:
export interface SessionCanvasContribution extends BaseContribution {
  component: ComponentType;
  /** MIME-like content type this renderer handles. */
  contentType: string;
}
```

**c) `SlotContributionMap`** (line 131): Remove `'session.canvas': SessionCanvasContribution;`. Keep `'right-panel': RightPanelContribution;` (line 132).

### 4. `apps/server/src/services/extensions/extension-templates.ts`

Four template comment lines (203, 249, 288, 348) each list available slots. Replace `session.canvas` with `right-panel` in each:

```
// Before:
//   sidebar.footer, sidebar.tabs, header.actions, dialog, session.canvas

// After:
//   sidebar.footer, sidebar.tabs, header.actions, dialog, right-panel
```

### 5. `apps/server/src/services/extensions/extension-test-harness.ts`

**Current** (line 26-29):

```typescript
  'header.actions',
  'dialog',
  'session.canvas',
];
```

**After**: Replace `'session.canvas'` with `'right-panel'`.

### 6. `apps/server/src/services/runtimes/claude-code/mcp-tools/extension-tools.ts`

**Current** (line 69-72):

```typescript
  | 'dialog'
  | 'settings.tabs'
  | 'session.canvas';
```

**After**: Replace `'session.canvas'` with `'right-panel'`.

### 7. `apps/client/src/layers/features/extensions/model/extension-api-factory.ts`

**Current** (line 235-236):

```typescript
    case 'session.canvas':
      return { ...base, component, contentType: 'extension' };
```

**After**:

```typescript
    case 'right-panel':
      return {
        ...base,
        component,
        title: id,
        icon: undefined as unknown as import('lucide-react').LucideIcon,
        visibleWhen: undefined,
      };
```

The `right-panel` case must return a shape matching `RightPanelContribution`: `{ title, icon, component, visibleWhen? }` plus `BaseContribution` fields.

### 8. `.claude/skills/marketplace-dev/SKILL.md`

Remove the `session.canvas` row from the Extension API slots table (line ~313):

```markdown
<!-- DELETE this row: -->

| `session.canvas` | Canvas area in sessions (deprecated — use `right-panel`) |
```

### Test File Updates

All test files that assert on `session.canvas` need to assert on `right-panel` instead.

**9. `apps/server/src/services/extensions/__tests__/extension-tools.test.ts` (line 63)**

```typescript
// Before:
'session.canvas': 0,
// After:
'right-panel': 0,
```

**10. `apps/server/src/services/extensions/__tests__/extension-manager-test.test.ts` (line 129)**

```typescript
// Before:
expect(contributions).toHaveProperty('session.canvas');
// After:
expect(contributions).toHaveProperty('right-panel');
```

**11. `apps/server/src/services/runtimes/claude-code/mcp-tools/__tests__/extension-tools-phase2.test.ts` (lines 38, 92, 197)**

Three occurrences — all `'session.canvas'` → `'right-panel'`.

**12. `apps/client/src/layers/shared/model/__tests__/extension-registry.test.ts` (line 77)**

```typescript
// Before:
expect(getContributions('session.canvas')).toEqual([]);
// After:
expect(getContributions('right-panel')).toEqual([]);
```

**13. `apps/client/src/layers/features/extensions/__tests__/extension-api-factory.test.ts` (line 50)**

```typescript
// Before:
'session.canvas',
// After:
'right-panel',
```

This test file was not listed in the ideation but contains a mock `availableSlots` Set that includes `session.canvas`.

## User Experience

No user-visible changes. The `right-panel` slot was already working before this spec. This is a code cleanup only.

## Testing Strategy

### Approach

This is a removal/renaming spec — no new tests are needed. All existing tests should continue to pass after replacing `session.canvas` references with `right-panel`.

### Verification Steps

1. **Type-check**: `pnpm tsc --noEmit` across all packages — ensures `ExtensionPointId` consumers compile with the new union type
2. **Unit tests**: `pnpm test -- --run` — ensures all 6 updated test files pass
3. **Grep verification**: `grep -r 'session\.canvas' --include='*.ts' --include='*.tsx' apps/ packages/` should return zero results
4. **Manual smoke test** (optional): Open the app, verify the right panel still opens with canvas content on `/session` routes

### Test Mutations by File

| Test File                             | Change                                                       | Validates                                       |
| ------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------- |
| `extension-tools.test.ts`             | `session.canvas` → `right-panel` in slot count assertion     | MCP tool lists correct slots                    |
| `extension-manager-test.test.ts`      | `session.canvas` → `right-panel` in contributions assertion  | Extension manager initializes all slots         |
| `extension-tools-phase2.test.ts` (×3) | `session.canvas` → `right-panel` in slot list and assertions | Phase 2 MCP tools use correct slot IDs          |
| `extension-registry.test.ts`          | `session.canvas` → `right-panel` in getContributions call    | Registry returns contributions for right-panel  |
| `extension-api-factory.test.ts`       | `session.canvas` → `right-panel` in mock availableSlots      | API factory creates correct contribution shapes |

## Performance Considerations

None. This is a dead-code removal — no runtime behavior changes.

## Security Considerations

None. The `session.canvas` slot was never exposed to untrusted input. The `right-panel` slot has the same security model.

## Documentation

- `contributing/extension-authoring.md` — already updated (prior commit `a2adfd08`)
- `contributing/state-management.md` — already updated (prior commit `a2adfd08`)
- `.claude/skills/marketplace-dev/SKILL.md` — updated in this spec (removes deprecated row)
- No new documentation needed.

## Implementation Phases

### Phase 1: Single Atomic Change (all changes in one commit)

This is a small, low-risk cleanup. All changes should be made in a single commit:

1. Update `ExtensionPointId` in `extension-api.ts` (add `right-panel`, remove `session.canvas`)
2. Update `availableSlots` in `main.tsx`
3. Remove `SESSION_CANVAS`, `SessionCanvasContribution`, and `SlotContributionMap` entry in `extension-registry.ts`
4. Update 4 template comments in `extension-templates.ts`
5. Update test harness in `extension-test-harness.ts`
6. Update MCP tool type in `extension-tools.ts`
7. Update API factory switch in `extension-api-factory.ts`
8. Update 6 test files (13 total references)
9. Remove deprecated row from `marketplace-dev/SKILL.md`
10. Run `pnpm tsc --noEmit` and `pnpm test -- --run` to verify

## Open Questions

None — all decisions have been made.

## Related ADRs

None currently exist. This is a straightforward dead-code removal that does not establish new architectural precedent.

## References

- Parent spec: `specs/shell-level-right-panel/02-specification.md` (spec #237)
- Ideation: `specs/deprecate-session-canvas-slot/01-ideation.md` (spec #239)
- Prior doc update commit: `a2adfd08` — marked `session.canvas` as deprecated in docs
- Extension registry: `apps/client/src/layers/shared/model/extension-registry.ts`
- Extension API contract: `packages/extension-api/src/extension-api.ts`
