---
slug: deprecate-session-canvas-slot
created: 2026-04-12
status: proposed
---

# Deprecate `session.canvas` Extension Slot

## Problem

The `session.canvas` extension slot is orphaned after the shell-level right panel migration (spec #237). The canvas now registers as a `right-panel` contribution via `init-extensions.ts`, but `session.canvas` still appears in:

- `packages/extension-api/src/extension-api.ts` — `ExtensionPointId` union type
- `apps/client/src/main.tsx` — `availableSlots` Set
- `apps/client/src/layers/shared/model/extension-registry.ts` — `SLOT_IDS.SESSION_CANVAS`, `SessionCanvasContribution`, `SlotContributionMap`
- `apps/server/src/services/extensions/extension-templates.ts` — 4 template comments
- `apps/server/src/services/extensions/extension-test-harness.ts` — test harness slots
- `apps/server/src/services/runtimes/claude-code/mcp-tools/extension-tools.ts` — MCP tool slot type
- `apps/client/src/layers/features/extensions/model/extension-api-factory.ts` — API factory switch case
- 5 test files with assertions referencing `session.canvas`

No code registers contributions to `session.canvas` anymore. The slot was intended for custom canvas content renderers but was never fully implemented — only the built-in canvas used it, and that now lives in `right-panel`.

## Proposed Solution

1. Remove `session.canvas` from all runtime code (types, constants, factory, templates)
2. Add `right-panel` to the `ExtensionPointId` type and extension API factory
3. Update all tests that assert on `session.canvas`
4. Keep `right-panel` as the canonical slot for panel tab contributions

## Scope

- `packages/extension-api/` — type update
- `apps/client/src/` — registry, main.tsx, API factory
- `apps/server/src/` — templates, test harness, MCP tools
- Test files across both apps

## Risk

Low. No third-party extensions have shipped using `session.canvas` (marketplace is not yet public). The only consumer was the built-in canvas, which has already migrated.

## Context

- Parent spec: `specs/shell-level-right-panel/02-specification.md` (spec #237)
- The `right-panel` slot and `RightPanelContribution` interface are already defined and working
- Documentation has already been updated to mark `session.canvas` as deprecated
