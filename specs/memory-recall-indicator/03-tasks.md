# Task Breakdown: Memory Recall Indicator

Generated: 2026-04-17
Source: specs/memory-recall-indicator/02-specification.md

## Overview

Surface when the Claude Agent SDK recalls memory files during a turn as a top-of-bubble lifecycle artifact. Extends the `MessagePart` discriminated union with a `memory_recall` variant, hooks the SSE event into the client stream handler with upsert/dedup semantics, and builds a `MemoryRecallBlock` component that mirrors `ThinkingBlock` line-for-line. All new client files live under `apps/client/src/layers/features/chat/`. Server plumbing (spec 245) is unchanged.

Phases are reviewer-friendly commit boundaries — all 5 phases ship as one PR.

---

## Phase 1: Schema (Foundation)

### Task 1.1: Add MemoryRecallPartSchema and extend MessagePart union

**Size**: small | **Priority**: high
**Dependencies**: —
**Parallel with**: —

**Files**:

- `packages/shared/src/schemas.ts`
- `packages/shared/src/types.ts`

**Implementation Steps**:

1. Add `MemoryRecallPartSchema` at `schemas.ts` immediately after `ElicitationPartSchema` (around line 886):

   ```ts
   export const MemoryRecallPartSchema = z
     .object({
       type: z.literal('memory_recall'),
       mode: z.enum(['select', 'synthesize']),
       memories: z.array(
         z.object({
           path: z.string(),
           scope: z.enum(['personal', 'team']),
           content: z.string().optional(),
         })
       ),
       isStreaming: z.boolean().optional(),
     })
     .openapi('MemoryRecallPart');

   export type MemoryRecallPart = z.infer<typeof MemoryRecallPartSchema>;
   ```

2. Extend the `MessagePartSchema` discriminated union at `schemas.ts:888` to include `MemoryRecallPartSchema`.
3. Re-export `MemoryRecallPart` from `packages/shared/src/types.ts` alongside existing part types (e.g., `ThinkingPart`, `BackgroundTaskPart`).

**Acceptance Criteria**:

- [ ] `pnpm typecheck` passes.
- [ ] `pnpm lint` passes (TSDoc required on new exports).
- [ ] Valid `select` and `synthesize` payloads `safeParse` with `success: true`.
- [ ] Missing-fields payload fails.
- [ ] `import type { MemoryRecallPart } from '@dorkos/shared/types'` resolves in downstream apps.

---

### Task 1.2: Add unit tests for MemoryRecallPartSchema

**Size**: small | **Priority**: high
**Dependencies**: 1.1
**Parallel with**: —

**Files**:

- `packages/shared/src/__tests__/schemas.test.ts` (create or extend)

**Implementation Steps**:

1. Add a `describe('MemoryRecallPartSchema')` block with 8 tests covering: valid select, valid synthesize with content + isStreaming, invalid mode, invalid scope, optional content, optional isStreaming, empty memories allowed at schema level, integration with `MessagePartSchema`.

**Acceptance Criteria**:

- [ ] `pnpm vitest run packages/shared/src/__tests__/schemas.test.ts` passes all 8 tests.
- [ ] Every test fails for the intended reason if the schema shape regresses.

---

## Phase 2: Stream handler (Core)

### Task 2.1: Implement upsertMemoryRecallPart helper

**Size**: small | **Priority**: high
**Dependencies**: 1.1
**Parallel with**: —

**Files**:

- `apps/client/src/layers/features/chat/model/stream/stream-event-helpers.ts`

**Implementation Steps**:

1. Add an exported `upsertMemoryRecallPart` helper that:
   - Inserts a new `memory_recall` part at `parts[0]` with `isStreaming: true` if absent (deduping within the first-event batch).
   - Appends incoming memories to the existing part if present, deduping by `path` and preserving first-seen `content` and `mode`.
   - Pure w.r.t. its `currentPartsRef` parameter (no other side effects).

**Acceptance Criteria**:

- [ ] `pnpm typecheck` passes.
- [ ] Helper is exported and importable from `stream-event-handler.ts`.
- [ ] TSDoc on the exported function.

---

### Task 2.2: Wire memory_recall case into stream-event-handler

**Size**: medium | **Priority**: high
**Dependencies**: 2.1
**Parallel with**: —

**Files**:

- `apps/client/src/layers/features/chat/model/stream/stream-event-handler.ts`

**Implementation Steps**:

1. Import `MemoryRecallEvent` from `@dorkos/shared/types` and `upsertMemoryRecallPart` from `./stream-event-helpers`.
2. Ensure the assistant message exists before inserting the part (reuse the `thinking_delta` ordering pattern at lines 87-100).
3. Add the case around line 257 (sibling to `system_status`):

   ```ts
   case 'memory_recall': {
     const recall = data as MemoryRecallEvent;
     helpers.ensureAssistantMessage(assistantId);
     upsertMemoryRecallPart(currentPartsRef, recall);
     helpers.flushPartsToMessage(assistantId);
     break;
   }
   ```

   (Adapt helper names to whatever `thinking_delta` currently uses.)

4. In the `done` case (line 307+), flip `isStreaming: false` on any `memory_recall` part inside `currentPartsRef.current`, adjacent to the existing thinking-finalization block at line 368-374.

**Acceptance Criteria**:

- [ ] `pnpm typecheck` passes.
- [ ] `pnpm lint` passes.
- [ ] Dispatching a `memory_recall` event places the part at `parts[0]`.
- [ ] On `done`, part transitions to `isStreaming: false`.
- [ ] No regression in existing cases.

---

### Task 2.3: Add unit tests for memory_recall handler case

**Size**: medium | **Priority**: high
**Dependencies**: 2.2
**Parallel with**: —

**Files**:

- `apps/client/src/layers/features/chat/model/__tests__/stream-event-handler-memory-recall.test.ts` (new)

**Implementation Steps**:

1. Mirror the `createMinimalDeps()` scaffold from `stream-event-handler-thinking.test.ts`.
2. Write 8 tests per §11.1 of the spec: insert at index 0, append on subsequent events, dedupe by path, preserve first-seen content, retain first-seen mode, flip isStreaming on done, no part when no events fire, create assistant message before inserting.

**Acceptance Criteria**:

- [ ] 8 tests pass: `pnpm vitest run apps/client/src/layers/features/chat/model/__tests__/stream-event-handler-memory-recall.test.ts`.
- [ ] Every test has a `// Purpose:` comment.
- [ ] Tests fail when `upsertMemoryRecallPart` is reverted.

---

## Phase 3: Component (Core)

### Task 3.1: Extend CollapsibleCard with 'memory' variant

**Size**: small | **Priority**: high
**Dependencies**: —
**Parallel with**: 2.1, 2.2, 2.3

**Files**:

- `apps/client/src/layers/features/chat/ui/primitives/CollapsibleCard.tsx`

**Implementation Steps**:

1. Update `variant?: 'default' | 'thinking'` → `variant?: 'default' | 'thinking' | 'memory'`.
2. Add a matching border treatment (`border-l-muted-foreground/20` for memory, matching thinking).
3. Update the TSDoc comment.

**Acceptance Criteria**:

- [ ] `pnpm typecheck` passes.
- [ ] Existing `CollapsibleCard.test.tsx` still passes.
- [ ] Passing `variant="memory"` renders without console errors.

---

### Task 3.2: Add truncateMiddle utility

**Size**: small | **Priority**: high
**Dependencies**: —
**Parallel with**: 3.1

**Files**:

- `apps/client/src/layers/shared/lib/truncate-middle.ts` (new)
- `apps/client/src/layers/shared/lib/index.ts` (barrel export)
- `apps/client/src/layers/shared/lib/__tests__/truncate-middle.test.ts`

**Implementation Steps**:

1. Implement `truncateMiddle(path, maxChars = 40)` per §9.4 of the spec: returns short paths unchanged; for long paths returns `<head>…/<basename>` with a minimum 6-char head budget.
2. Export from the shared lib barrel.
3. Add 4 tests: short path unchanged, long path ellipsed with basename preserved, minimum head budget, handles no-slash paths.

**Acceptance Criteria**:

- [ ] `pnpm vitest run apps/client/src/layers/shared/lib/__tests__/truncate-middle.test.ts` passes 4 tests.
- [ ] Exported via `@/layers/shared/lib`.

---

### Task 3.3: Build MemoryRecallBlock component

**Size**: large | **Priority**: high
**Dependencies**: 1.1, 3.1, 3.2
**Parallel with**: —

**Files**:

- `apps/client/src/layers/features/chat/ui/message/MemoryRecallBlock.tsx` (new)
- `apps/client/src/layers/features/chat/ui/message/index.ts` (barrel export)

**Implementation Steps**:

1. Build `MemoryRecallBlock` mirroring `ThinkingBlock` (see §9.4 of spec for the reference implementation): `useState` for expanded, `useRef` for `wasStreaming`, auto-collapse `useEffect` on streaming→done transition.
2. `headerLabel` states:
   - Streaming, 1 memory: `'Consulting memory…'`
   - Streaming, N memories: `'Consulting N memories…'`
   - Done, 1 memory: `'Recalled 1 memory'`
   - Done, N memories: `'Recalled N memories'`
3. `HeaderIcon`: `Sparkles` for synthesize, `BookOpen` otherwise (mixed mode stays `BookOpen`).
4. Render nothing when `memories.length === 0`.
5. `MemoryRecallList` + `MemoryRecallRow` (inline or split to separate file if combined >200 lines):
   - Select rows: mono path with `truncateMiddle(path, 40)` + scope icon (`User`/`Users`).
   - Synthesize rows (detected by `<synthesis:...>` sentinel): body-text paragraph + muted `synthesis:DIR` label beneath.
   - Rows are `<button>` with `min-h-[44px]`, `focus-ring`, and `aria-label` (`Copy path ${path}` or `Copy synthesized memory content`).
   - Tap calls `navigator.clipboard.writeText(memory.content ?? path)` and fires existing DorkOS toast (grep for current toast usage; do not introduce new primitive).
6. Use existing design tokens: `text-3xs`, `text-muted-foreground`, `font-mono`, `size-(--size-icon-xs)`.
7. Export from the message barrel `index.ts`.

**Acceptance Criteria**:

- [ ] `pnpm typecheck` passes.
- [ ] `pnpm lint` passes.
- [ ] File stays under 300 lines.
- [ ] Exported from message barrel.

---

### Task 3.4: Add component tests for MemoryRecallBlock

**Size**: large | **Priority**: high
**Dependencies**: 3.3
**Parallel with**: —

**Files**:

- `apps/client/src/layers/features/chat/ui/message/__tests__/MemoryRecallBlock.test.tsx` (new)

**Implementation Steps**:

1. Use `@vitest-environment jsdom` + `@testing-library/react`, matching `ThinkingBlock.test.tsx`.
2. Mock `navigator.clipboard.writeText` in `beforeEach`.
3. 12 component tests per §11.2: streaming label, completed chip count, auto-collapse on transition, expand/collapse on tap, BookOpen for select, Sparkles for synthesize, BookOpen for mixed mode, path truncation, synthesis paragraph + directory label, scope icons only when expanded, clipboard copy with exact args, synthesis content (not sentinel) copied, nothing rendered on empty memories.
4. 3 mobile-viewport tests per §11.4: chip fits at 320px, paths truncate at 320px, rows ≥44px tall.
5. Every test has a `// Purpose:` comment.

**Acceptance Criteria**:

- [ ] 16 tests pass: `pnpm vitest run apps/client/src/layers/features/chat/ui/message/__tests__/MemoryRecallBlock.test.tsx`.
- [ ] Clipboard mocks asserted with specific arguments (not just `.toHaveBeenCalled()`).
- [ ] Icon assertions use `aria-label` queries.

---

## Phase 4: Dispatch wiring

### Task 4.1: Dispatch memory_recall part in AssistantMessageContent

**Size**: small | **Priority**: high
**Dependencies**: 3.3
**Parallel with**: —

**Files**:

- `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx`

**Implementation Steps**:

1. Import `MemoryRecallBlock`.
2. Add a dispatch branch inside `renderPart` (around line 226), after the `elicitation` branch, before the `tool_call` fallback:

   ```tsx
   if (part.type === 'memory_recall') {
     return (
       <MemoryRecallBlock
         key={`memory-recall-${i}`}
         mode={part.mode}
         memories={part.memories}
         isStreaming={part.isStreaming ?? false}
       />
     );
   }
   ```

3. Do NOT add `memory_recall` to the `isCollapsible` run-grouping at line 356 — it renders standalone at `parts[0]`.

**Acceptance Criteria**:

- [ ] `pnpm typecheck` passes.
- [ ] `pnpm lint` passes.
- [ ] Rendering a message with a `memory_recall` part produces `MemoryRecallBlock` in the DOM.
- [ ] No regression in other part types.

---

## Phase 5: Integration + Polish

### Task 5.1: Add integration tests for SSE → rendered bubble

**Size**: medium | **Priority**: high
**Dependencies**: 2.2, 4.1
**Parallel with**: —

**Files**:

- `apps/client/src/layers/features/chat/__tests__/memory-recall-integration.test.tsx` (new)

**Implementation Steps**:

1. 2 integration tests per §11.3:
   - `memory_recall` event during streaming → `MemoryRecallBlock` renders at top of assistant bubble.
   - No `memory_recall` event → no block in DOM.
2. 1 regression test per §11.5: message with all 6 existing part types (no `memory_recall`) renders in the same order as before.
3. Use whichever test style existing chat integration tests use (direct handler + mount, or SSE mock).

**Acceptance Criteria**:

- [ ] 3 new tests pass.
- [ ] Tests fail if dispatch (task 4.1) is reverted.
- [ ] Regression test exercises all 6 existing part types.

---

### Task 5.2: Accessibility, reduced-motion, and docs polish

**Size**: medium | **Priority**: medium
**Dependencies**: 3.3, 3.4, 4.1, 5.1
**Parallel with**: —

**Files**:

- Component files (verify only, adjust if needed)
- `contributing/state-management.md` or `contributing/data-fetching.md`
- Pending changelog entry

**Implementation Steps**:

1. Accessibility verification: chip `aria-expanded` + `aria-label`, row `aria-label`, scope icon `aria-label`, `focus-ring`, full keyboard flow.
2. Reduced-motion: confirm `animate-tasks` respects `prefers-reduced-motion`; match whatever pattern `ThinkingBlock` uses.
3. Mobile viewport ≥44px tap targets and single-line chip at 320px (covered by tests).
4. Icon import consolidation: grep for existing `BookOpen`, `Sparkles`, `User`, `Users` imports and dedupe if an icon-barrel file exists.
5. Docs: add entry in `contributing/` describing the new part lifecycle with pointer to `MemoryRecallBlock.tsx`.
6. TSDoc on all new exported symbols.
7. Changelog line: `Chat: Memory recall indicator — see which memory files shaped each response.`
8. Optional playground showcase in `apps/client/src/dev/`.

**Acceptance Criteria**:

- [ ] Manual keyboard run-through works without mouse.
- [ ] `prefers-reduced-motion: reduce` disables breathing animation.
- [ ] TSDoc coverage on all new exports.
- [ ] `contributing/` entry added.
- [ ] Changelog entry drafted.
- [ ] `pnpm test && pnpm typecheck && pnpm lint` all green.

---

## Parallel Opportunities

- **3.1 (CollapsibleCard variant)** and **3.2 (truncateMiddle util)** can run alongside Phase 2 tasks (2.1, 2.2, 2.3) — they touch disjoint files.
- **1.2 (schema tests)** can run in parallel with the start of **2.1** since they only depend on 1.1.

## Critical Path

1.1 → 2.1 → 2.2 → 2.3 → (3.1 + 3.2 completed) → 3.3 → 3.4 → 4.1 → 5.1 → 5.2
