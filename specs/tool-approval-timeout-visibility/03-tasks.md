# Tool Approval Timeout Visibility — Task Breakdown

**Spec:** `specs/tool-approval-timeout-visibility/02-specification.md`
**Generated:** 2026-03-16

## Phase 1: Foundation

### 1.1 Add timeoutMs to ApprovalEventSchema and ToolCallPartSchema

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.2

Extend two Zod schemas in `packages/shared/src/schemas.ts`:

- `ApprovalEventSchema` — add required `timeoutMs: z.number()` field
- `ToolCallPartSchema` — add optional `timeoutMs: z.number().optional()` field

The inferred TypeScript types (`ApprovalEvent`, `ToolCallPart`) update automatically.

---

### 1.2 Add drain keyframe and animate-drain utility to CSS

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.1

Add to `apps/client/src/index.css`:

- `@keyframes drain` — width transitions from 100% to 0%
- `@utility animate-drain` — Tailwind v4 custom utility registering the keyframe

The `motion-safe:` variant prefix (built into Tailwind) ensures the animation respects `prefers-reduced-motion`.

---

### 1.3 Include timeoutMs in server approval_required event payload

**Size:** Small | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 1.4

In `apps/server/src/services/runtimes/claude-code/interactive-handlers.ts`, add `timeoutMs: SESSIONS.INTERACTION_TIMEOUT_MS` to the `approval_required` event data object in `handleToolApproval`. The constant is already imported.

---

### 1.4 Pass timeoutMs through stream-event-handler to tool call parts

**Size:** Small | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 1.3

Three files:

- `apps/client/src/layers/features/chat/model/stream-event-handler.ts` — pass `approval.timeoutMs` through in the `approval_required` case (both existing-part and new-part branches), and include `timeoutMs` in `deriveFromParts`
- `apps/client/src/layers/features/chat/model/chat-types.ts` — add `timeoutMs?: number` to `ToolCallState` interface

---

## Phase 2: Feature

### 2.1 Implement countdown timer, progress bar, and warning phases in ToolApproval

**Size:** Large | **Priority:** High | **Dependencies:** 1.1, 1.2, 1.3, 1.4

Primary component change in `apps/client/src/layers/features/chat/ui/ToolApproval.tsx`:

- Add `timeoutMs` prop
- `useEffect` + `setInterval` countdown from `timeoutMs` to 0
- Derive `ApprovalPhase` (`normal` / `warning` / `urgent` / `expired`) from `secondsRemaining`
- Render progress bar with `role="progressbar"`, `aria-valuenow`, `aria-valuetext`
- CSS animation via `motion-safe:animate-drain` with inline `animationDuration`
- Text countdown visible only in warning/urgent phases (last 2 minutes)
- Timeout expiration sets `decided` to `denied` with explanatory message
- Screen reader `aria-live="assertive"` announcements at 2min, 1min, and expiry
- Wire `timeoutMs` through from `AssistantMessageContent.tsx`

---

### 2.2 Add unit tests for countdown, progress bar, and timeout behavior

**Size:** Medium | **Priority:** High | **Dependencies:** 2.1

Add to `apps/client/src/layers/features/chat/__tests__/ToolApproval.test.tsx`:

- Progress bar renders with correct ARIA attributes when `timeoutMs` provided
- No progress bar when `timeoutMs` undefined (backward compat)
- No text countdown before warning threshold (5min mark)
- Text countdown appears at 2-minute warning threshold
- Correct countdown format (e.g., "1:30 remaining")
- Urgent styling at 1-minute threshold
- Timeout transitions to denied state with "Auto-denied" message
- No timeout message on manual deny
- Approve works mid-countdown, no timeout message
- Screen reader announcements at warning/urgent thresholds
- `aria-valuenow` updates as time passes

All tests use `vi.useFakeTimers()` / `vi.advanceTimersByTime()`.

---

### 2.3 Update interactive-tools.md documentation

**Size:** Small | **Priority:** Medium | **Dependencies:** 2.1 | **Parallel with:** 2.2

Add a "Timeout Visibility" subsection to `contributing/interactive-tools.md` documenting the progress bar, warning/urgent phases, expiry behavior, and screen reader announcements.

---

## Dependency Graph

```
1.1 (schemas) ──┬── 1.3 (server payload) ──┐
                │                           │
                └── 1.4 (stream handler) ───┤
                                            │
1.2 (CSS keyframe) ────────────────────────┤
                                            │
                                            └── 2.1 (ToolApproval component) ──┬── 2.2 (tests)
                                                                                │
                                                                                └── 2.3 (docs)
```

Tasks 1.1 and 1.2 can run in parallel. Tasks 1.3 and 1.4 can run in parallel (both depend on 1.1). Task 2.1 depends on all four foundation tasks. Tasks 2.2 and 2.3 can run in parallel after 2.1.
