# Tool Call Display Overhaul — Task Breakdown

**Spec:** `specs/tool-call-display-overhaul/02-specification.md`
**Generated:** 2026-03-23
**Mode:** Full decomposition

---

## Phase 1: Bug Fixes (Foundation)

Three tasks that fix the existing bugs. Tasks 1.1, 1.2, and 1.3 can run in parallel. Task 1.4 depends on 1.1 and 1.3.

### Task 1.1 — Add MCP tool name parsing and server badge to tool-labels.ts

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.2, 1.3

Add `parseMcpToolName()`, `getMcpServerBadge()`, and `humanizeSnakeCase()` to `tool-labels.ts`. Wire into `getToolLabel()` default case so MCP tool names like `mcp__slack__send_message` display as "Send message". Known server labels map (`DorkOS`, `Slack`, `Telegram`, `GitHub`, `Files`, `Browser`, `Context7`); unknown servers humanized from snake_case. `getMcpServerBadge` returns null for `mcp__dorkos__*` tools (implicit context). Update barrel exports and add test coverage.

**Files modified:**

- `apps/client/src/layers/shared/lib/tool-labels.ts`
- `apps/client/src/layers/shared/lib/index.ts`
- `apps/client/src/layers/shared/lib/__tests__/tool-labels.test.ts`

---

### Task 1.2 — Fix streaming display in ToolCallCard and ToolArgumentsDisplay

**Size:** Medium | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.1, 1.3

Fix two bugs: (1) empty tool card body during streaming, (2) garbled partial JSON display. Add `isStreaming` prop to `ToolArgumentsDisplay` — when true, renders raw accumulating text with a pulse dot instead of attempting JSON.parse. Fix falsy `input` check in `ToolCallCard` body: show "Preparing..." spinner between `tool_call_start` and first delta, pass `isStreaming=true` during streaming, render formatted grid after completion.

**Files modified:**

- `apps/client/src/layers/shared/lib/tool-arguments-formatter.tsx`
- `apps/client/src/layers/features/chat/ui/ToolCallCard.tsx`
- `apps/client/src/layers/shared/lib/__tests__/tool-arguments-formatter.test.tsx`
- `apps/client/src/layers/features/chat/ui/__tests__/ToolCallCard.test.tsx`

---

### Task 1.3 — Add execution duration tracking and display

**Size:** Medium | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.1, 1.2

Add `startedAt` and `completedAt` optional fields to `ToolCallState`. Set `startedAt: Date.now()` in `handleToolCallStart`, `completedAt: Date.now()` in `handleToolResult`. Create `formatDuration()` utility with tiered display (<100ms / 347ms / 1.2s / 14s / 1m 23s). Add duration badge to ToolCallCard header, right-aligned with `ml-auto tabular-nums`. Historical tool calls (no timestamps) show no badge.

**Files created:**

- `apps/client/src/layers/shared/lib/format-duration.ts`
- `apps/client/src/layers/shared/lib/__tests__/format-duration.test.ts`

**Files modified:**

- `apps/client/src/layers/features/chat/model/chat-types.ts`
- `apps/client/src/layers/features/chat/model/stream-tool-handlers.ts`
- `apps/client/src/layers/features/chat/ui/ToolCallCard.tsx`
- `apps/client/src/layers/shared/lib/index.ts`
- `apps/client/src/layers/features/chat/ui/__tests__/ToolCallCard.test.tsx`

---

### Task 1.4 — Integrate MCP server badge into ToolCallCard header

**Size:** Small | **Priority:** High | **Dependencies:** 1.1, 1.3 | **Parallel with:** None

Wire `getMcpServerBadge()` into ToolCallCard header. Show badge (`bg-muted text-muted-foreground text-3xs rounded px-1 py-0.5 font-medium`) before the tool label for third-party MCP tools. DorkOS tools and SDK tools get no badge. Add test coverage.

**Files modified:**

- `apps/client/src/layers/features/chat/ui/ToolCallCard.tsx`
- `apps/client/src/layers/features/chat/ui/__tests__/ToolCallCard.test.tsx`

---

## Phase 2: Enhanced Output Rendering

Four tasks for content-type classified output rendering. Tasks 2.1 and 2.2 can run in parallel. Task 2.3 depends on both. Task 2.4 depends on 2.3.

### Task 2.1 — Install new rendering libraries in apps/client

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel with:** 2.2

Install `react-json-view-lite@^2.0.0`, `ansi-to-react@^6.0.10`, `react-diff-viewer-continued@^4.2.0`, and `ansi-regex@^6.0.0` in `apps/client/`. Verify typecheck and build pass.

**Files modified:**

- `apps/client/package.json`
- `pnpm-lock.yaml`

---

### Task 2.2 — Create content classifier utility

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel with:** 2.1

Create `classifyContent()` function that returns `'json'`, `'ansi'`, or `'plain'` for a given string. Uses `ansi-regex` for ANSI detection (most specific signal first), then `JSON.parse` for JSON objects/arrays, fallback to plain. Add barrel export and full test coverage.

**Files created:**

- `apps/client/src/layers/shared/lib/classify-content.ts`
- `apps/client/src/layers/shared/lib/__tests__/classify-content.test.ts`

**Files modified:**

- `apps/client/src/layers/shared/lib/index.ts`

---

### Task 2.3 — Create OutputRenderer component with JSON tree, ANSI, and diff rendering

**Size:** Large | **Priority:** High | **Dependencies:** 2.1, 2.2 | **Parallel with:** None

Create `OutputRenderer` component in `features/chat/ui/`. Renders tool output with content-type-appropriate formatting: `react-json-view-lite` for JSON (collapsed by default), `ansi-to-react` for ANSI-colored output, lazy-loaded `react-diff-viewer-continued` for Edit tool diffs. Includes `OutputWrapper` for consistent truncation (5KB) and "Raw" toggle, and `EditDiffOutput` sub-component that extracts `old_string`/`new_string` from tool input. Full test coverage with mocked libraries.

**Files created:**

- `apps/client/src/layers/features/chat/ui/OutputRenderer.tsx`
- `apps/client/src/layers/features/chat/ui/__tests__/OutputRenderer.test.tsx`

---

### Task 2.4 — Integrate OutputRenderer into ToolCallCard for tool results

**Size:** Medium | **Priority:** High | **Dependencies:** 2.3, 1.2 | **Parallel with:** None

Replace `TruncatedOutput` for `toolCall.result` with `OutputRenderer` in ToolCallCard. Keep `TruncatedOutput` for `progressOutput` (always plain text). Add OutputRenderer mock to ToolCallCard tests. Update truncation tests to work with the new rendering path.

**Files modified:**

- `apps/client/src/layers/features/chat/ui/ToolCallCard.tsx`
- `apps/client/src/layers/features/chat/ui/__tests__/ToolCallCard.test.tsx`

---

## Phase 3: Polish

Three tasks for theming and verification. Tasks 3.1 and 3.2 can run in parallel. Task 3.3 depends on everything.

### Task 3.1 — Theme react-json-view-lite for DorkOS dark palette

**Size:** Small | **Priority:** Medium | **Dependencies:** 2.3 | **Parallel with:** 3.2, 3.3

Create custom dark style for `react-json-view-lite` matching the DorkOS neutral gray palette. Keys in muted foreground, numbers in blue, booleans in amber, transparent background. Verify no CSS conflicts with Tailwind v4.

**Files modified:**

- `apps/client/src/layers/features/chat/ui/OutputRenderer.tsx`

---

### Task 3.2 — Theme react-diff-viewer-continued for DorkOS dark palette

**Size:** Small | **Priority:** Medium | **Dependencies:** 2.3 | **Parallel with:** 3.1, 3.3

Configure dark theme overrides for the diff viewer: transparent background, subtle green/red tints for added/removed lines. Verify Emotion CSS-in-JS doesn't conflict with Tailwind v4.

**Files modified:**

- `apps/client/src/layers/features/chat/ui/OutputRenderer.tsx`

---

### Task 3.3 — Final barrel exports and cross-cutting verification

**Size:** Small | **Priority:** Medium | **Dependencies:** 1.4, 2.4, 3.1, 3.2 | **Parallel with:** None

Verify all barrel exports are complete. Run full test suite (`pnpm test -- --run`), typecheck, lint. Verify FSD layer compliance. Confirm no dead code, no regressions. OutputRenderer stays internal to features/chat (not exported from barrel).

**Files verified:**

- `apps/client/src/layers/shared/lib/index.ts`
- `apps/client/src/layers/features/chat/index.ts`

---

## Dependency Graph

```
Phase 1 (parallel):
  1.1 ─────────┐
  1.2 ──────┐  ├──→ 1.4
  1.3 ──────┼──┘
            │
Phase 2:    │
  2.1 ──┐   │
  2.2 ──┼──→ 2.3 ──→ 2.4
        │              │
Phase 3:│              │
  3.1 ←─┘──────┐      │
  3.2 ←─────────┤     │
                ├──→ 3.3
  1.4 ──────────┤
  2.4 ──────────┘
```

## Summary

| Phase     | Tasks  | Size             | Description                                                                       |
| --------- | ------ | ---------------- | --------------------------------------------------------------------------------- |
| 1         | 4      | 2S + 2M          | Bug fixes: MCP names, streaming display, duration tracking, badge integration     |
| 2         | 4      | 2S + 1M + 1L     | Enhanced output: library install, content classifier, OutputRenderer, integration |
| 3         | 3      | 3S               | Polish: JSON theme, diff theme, verification                                      |
| **Total** | **11** | **5S + 3M + 1L** |                                                                                   |
