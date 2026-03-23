# Implementation Summary: Tool Call Display Overhaul

**Created:** 2026-03-23
**Last Updated:** 2026-03-23
**Spec:** specs/tool-call-display-overhaul/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 11 / 11

## Tasks Completed

### Session 1 - 2026-03-23

#### Batch 1 (Parallel: 4 agents)

- **#1 [P1] MCP tool name parsing** — SUCCESS (36/36 tests)
  - Added `parseMcpToolName()`, `getMcpServerBadge()`, `humanizeSnakeCase()`, `MCP_SERVER_LABELS` map
  - Updated `getToolLabel()` default case to parse MCP names
- **#2 [P1] Streaming display fix** — SUCCESS (18/18 tests)
  - Fixed falsy `toolCall.input` check with three-way conditional
  - Added `isStreaming` prop to `ToolArgumentsDisplay` with pulse dot indicator
  - Added "Preparing..." state between `tool_call_start` and first delta
- **#3 [P1] Duration tracking** — SUCCESS (6+19 tests)
  - Added `startedAt`/`completedAt` to `ToolCallState` and `ToolCallPartSchema`
  - Set timestamps in `handleToolCallStart` and `handleToolResult`
  - Created `formatDuration()` with tiered display
  - Added duration badge to ToolCallCard header
- **#5 [P2] Install libraries** — SUCCESS
  - Installed react-json-view-lite, ansi-to-react, react-diff-viewer-continued, ansi-regex
- **#6 [P2] Content classifier** — SUCCESS (14/14 tests)
  - Created `classifyContent()` utility (json/ansi/plain detection)
  - Used `ansiRegex({ onlyFirst: true })` for safe repeated regex calls

## Files Modified/Created

**Source files:**

- `apps/client/src/layers/shared/lib/tool-labels.ts` — MCP parsing
- `apps/client/src/layers/shared/lib/tool-arguments-formatter.tsx` — Streaming awareness
- `apps/client/src/layers/shared/lib/classify-content.ts` — NEW: Content classifier
- `apps/client/src/layers/shared/lib/format-duration.ts` — NEW: Duration formatter
- `apps/client/src/layers/shared/lib/index.ts` — Barrel exports updated
- `apps/client/src/layers/features/chat/ui/ToolCallCard.tsx` — Streaming fix + duration badge
- `apps/client/src/layers/features/chat/model/chat-types.ts` — startedAt/completedAt fields
- `apps/client/src/layers/features/chat/model/stream-tool-handlers.ts` — Timestamp setting
- `apps/client/src/layers/features/chat/model/stream-event-helpers.ts` — deriveFromParts updated
- `packages/shared/src/schemas.ts` — ToolCallPartSchema timestamps

**Test files:**

- `apps/client/src/layers/shared/lib/__tests__/tool-labels.test.ts` — 29 new MCP tests
- `apps/client/src/layers/shared/lib/__tests__/classify-content.test.ts` — NEW: 14 tests
- `apps/client/src/layers/shared/lib/__tests__/format-duration.test.ts` — NEW: 6 tests
- `apps/client/src/layers/shared/lib/__tests__/tool-arguments-formatter.test.tsx` — 4 new streaming tests
- `apps/client/src/layers/features/chat/ui/__tests__/ToolCallCard.test.tsx` — 6 new tests

#### Batch 2 (Parallel: 2 agents)

- **#4 [P1] MCP badge in ToolCallCard header** — SUCCESS (23/23 tests)
  - Added `getMcpServerBadge()` call in header between status icon and tool label
  - Badge shows as `text-[10px]` chip with `bg-muted` background
  - 4 new tests for badge rendering
- **#7 [P2] OutputRenderer component** — SUCCESS (10/10 tests)
  - Created `OutputRenderer.tsx` with JSON tree, ANSI styled, diff, and plain text rendering
  - JSON: `react-json-view-lite` with custom `dorkosJsonStyles`
  - ANSI: `ansi-to-react` styled output
  - Edit/diff: `react-diff-viewer-continued` lazy-loaded via `React.lazy()` + `<Suspense>`
  - 5KB truncation with expand, Raw/Formatted toggle for JSON and ANSI

#### Batch 3 (Parallel: 3 agents)

- **#8 [P2] OutputRenderer integration** — SUCCESS (23/23 tests)
  - Replaced `TruncatedOutput` with `OutputRenderer` for `toolCall.result` in ToolCallCard
  - Kept `TruncatedOutput` for `progressOutput` (simpler content)
- **#9 [P3] JSON viewer theme** — SUCCESS (typecheck clean)
  - Custom `dorkosJsonStyles` object with Tailwind utility classes
  - Colors: `text-foreground`, `text-muted-foreground`, `text-amber-400` (booleans), `text-blue-400` (numbers)
- **#10 [P3] Diff viewer theme** — SUCCESS (typecheck clean)
  - DarkOS dark palette overrides: transparent background, subtle green/red tints at 10% opacity

#### Batch 4 (Verification)

- **#11 [P3] Final verification** — SUCCESS
  - Barrel exports verified: `getMcpServerBadge`, `parseMcpToolName`, `formatDuration`, `classifyContent` all exported
  - `OutputRenderer` correctly NOT exported from `features/chat/index.ts` (internal component)
  - FSD compliance: shared lib has zero imports from upper layers
  - Typecheck: 15/15 packages clean
  - Lint: 0 errors (5 pre-existing warnings in relay wizard — unrelated)
  - Client tests: **233/233 files, 2678/2678 tests pass**

## Files Modified/Created

**Source files:**

- `apps/client/src/layers/shared/lib/tool-labels.ts` — MCP parsing
- `apps/client/src/layers/shared/lib/tool-arguments-formatter.tsx` — Streaming awareness
- `apps/client/src/layers/shared/lib/classify-content.ts` — NEW: Content classifier
- `apps/client/src/layers/shared/lib/format-duration.ts` — NEW: Duration formatter
- `apps/client/src/layers/shared/lib/index.ts` — Barrel exports updated
- `apps/client/src/layers/features/chat/ui/ToolCallCard.tsx` — Streaming fix, duration badge, MCP badge, OutputRenderer
- `apps/client/src/layers/features/chat/ui/OutputRenderer.tsx` — NEW: Content-type classified rendering
- `apps/client/src/layers/features/chat/model/chat-types.ts` — startedAt/completedAt fields
- `apps/client/src/layers/features/chat/model/stream-tool-handlers.ts` — Timestamp setting
- `apps/client/src/layers/features/chat/model/stream-event-helpers.ts` — deriveFromParts updated

**Test files:**

- `apps/client/src/layers/shared/lib/__tests__/tool-labels.test.ts` — 29 new MCP tests
- `apps/client/src/layers/shared/lib/__tests__/classify-content.test.ts` — NEW: 14 tests
- `apps/client/src/layers/shared/lib/__tests__/format-duration.test.ts` — NEW: 6 tests
- `apps/client/src/layers/shared/lib/__tests__/tool-arguments-formatter.test.tsx` — 4 new streaming tests
- `apps/client/src/layers/features/chat/ui/__tests__/ToolCallCard.test.tsx` — 8 tests (streaming, duration, MCP badge, OutputRenderer)
- `apps/client/src/layers/features/chat/ui/__tests__/OutputRenderer.test.tsx` — NEW: 10 tests

## Known Issues

_(None)_

## Implementation Notes

### Session 1

- Batch 1: 93/93 tests pass, typecheck clean
- `ToolCallPartSchema` already had `startedAt`/`completedAt` fields (discovered during install task)
- Agent C detected concurrent edits to ToolCallCard.tsx and adapted its changes to header-only
- `ansiRegex()` returns global regex by default — used `{ onlyFirst: true }` for safe reuse

### Session 2 (continuation)

- Batches 2-4 completed, full verification pass
- `react-diff-viewer-continued` (~1.08MB) lazy-loaded to avoid bundle impact
- `react-json-view-lite` styled with Tailwind utility class names (not inline CSS) via `dorkosJsonStyles`
- Client test suite: 233 files, 2678 tests — zero failures
- Pre-existing `@dorkos/db` migration test failure (A2A tables) — unrelated to this spec
