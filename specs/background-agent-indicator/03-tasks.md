# Background Agent Indicator — Task Breakdown

**Spec:** `specs/background-agent-indicator/02-specification.md`
**Generated:** 2026-03-23
**Mode:** Full

---

## Phase 1: Core Hook + Static Indicator

### Task 1.1 — Create `useRunningSubagents` hook [medium, high]

**File:** `apps/client/src/layers/features/chat/model/use-running-subagents.ts`

Create the hook that derives `RunningAgent[]` from the messages array. Scans all `messages[].parts` for `SubagentPart` entries (`part.type === 'subagent'`). Uses `useRef<Map>` for stable color assignment (round-robin from 5-color palette). Tracks completion transitions via `useRef` and keeps completed agents in the array for 1.5s to allow celebration animations.

**Dependencies:** None
**Parallel:** None

---

### Task 1.2 — Create `RunningAgentIndicator` component (static) [medium, high]

**File:** `apps/client/src/layers/features/chat/ui/RunningAgentIndicator.tsx`

Renders the indicator bar with agent count label, aggregate stats (tool count, duration), and placeholder colored dots for agents. Wraps in `AnimatePresence` for bar enter/exit transitions. Returns `null` when agents array is empty. Has `role="status"` and `aria-live="polite"`.

**Dependencies:** 1.1
**Parallel:** None

---

### Task 1.3 — Wire through ChatPanel to ChatInputContainer [small, high]

**Files:** `ChatPanel.tsx`, `ChatInputContainer.tsx`

Call `useRunningSubagents(messages)` in ChatPanel, pass result as `runningAgents` prop to ChatInputContainer. Render `RunningAgentIndicator` between `<ChatInput>` and `<ChatStatusSection>`.

**Dependencies:** 1.1, 1.2
**Parallel:** None

---

### Task 1.4 — Write `useRunningSubagents` unit tests [medium, high]

**File:** `apps/client/src/layers/features/chat/model/__tests__/use-running-subagents.test.ts`

6 test cases: empty messages, running extraction, completion timeout (1.5s with fake timers), stable colors per taskId, round-robin color cycling, scanning all messages.

**Dependencies:** 1.1
**Parallel:** Can run in parallel with 1.2, 1.3

---

## Phase 2: Animated Running Figure

### Task 2.1 — Create `agent-runner.css` with all @keyframes [small, high]

**File:** `apps/client/src/layers/features/chat/ui/agent-runner.css`

12 animation classes for the V3D runner: body bounce (r-bounce), right/left leg (r-rt, r-rs, r-lt, r-ls), right/left arm (r-rua, r-rfa, r-lua, r-lfa). Plus checkmark scale-in and burst-particle keyframes. Includes `@media (prefers-reduced-motion: reduce)` to disable all.

**Dependencies:** None
**Parallel:** 2.2

---

### Task 2.2 — Create `AgentRunner` component with SVG figure [medium, high]

**File:** `apps/client/src/layers/features/chat/ui/AgentRunner.tsx`

22x24px SVG with head (circle), eye highlight, body (ellipse), and jointed limbs (line segments in nested `<g>` groups). Uses `--c` CSS custom property for agent color. Staggered `animation-delay: index * 0.09s`. Replaces Phase 1 dot placeholders in RunningAgentIndicator.

**Dependencies:** 1.2
**Parallel:** 2.1

---

### Task 2.3 — Add slot-unfold enter/exit transitions [small, high]

**File:** `apps/client/src/layers/features/chat/ui/RunningAgentIndicator.tsx`

Wrap each `AgentRunner` in `motion.div` with `AnimatePresence mode="popLayout"`. Enter: `width: 0 → 22, opacity: 0 → 1` (0.4s, ease `[0.16, 1, 0.3, 1]`). Exit: `width: 22 → 0, opacity: 1 → 0` (0.35s).

**Dependencies:** 2.2
**Parallel:** 2.4

---

### Task 2.4 — Add CSS-only hover tooltip [small, medium]

**File:** `apps/client/src/layers/features/chat/ui/AgentRunner.tsx`

CSS-only tooltip using Tailwind `group`/`group-hover:` classes. Shows agent description with colored dot, tool count + duration in monospace, and last tool name. Positioned above runner with downward CSS triangle arrow.

**Dependencies:** 2.2
**Parallel:** 2.3

---

## Phase 3: Completion Celebrations

### Task 3.1 — Create `AgentRunnerBurst` particle burst component [small, medium]

**File:** `apps/client/src/layers/features/chat/ui/AgentRunnerBurst.tsx`

8 `<span>` particles positioned at center, each with CSS animation translating outward in a unique direction (via `--bx`/`--by` custom properties) and fading to opacity 0. Uses `burst-particle` keyframe from agent-runner.css. Total duration ~0.5s.

**Dependencies:** 2.1
**Parallel:** None

---

### Task 3.2 — Implement completion lifecycle in AgentRunner [large, high]

**File:** `apps/client/src/layers/features/chat/ui/AgentRunner.tsx`

Three-phase internal lifecycle: `running` → `celebrating` → `done`. Detects status transition via `useRef`. Celebrating phase shows burst + runner (350ms), then swaps to checkmark SVG (or error X icon). Timing: 350ms burst → checkmark scale-in → slot collapse after hook's 1.5s timer.

**Dependencies:** 2.2, 2.4, 3.1
**Parallel:** None

---

### Task 3.3 — Write component render tests [medium, medium]

**File:** `apps/client/src/layers/features/chat/ui/__tests__/RunningAgentIndicator.test.tsx`

5 test cases: empty renders nothing, correct figure count, overflow badge for 5+ agents, aggregate stats display, tooltip content in DOM. Mocks `motion/react` for jsdom compatibility.

**Dependencies:** 2.2, 2.3
**Parallel:** None

---

## Phase 4: Polish

### Task 4.1 — Overflow badge for 5+ agents [small, medium]

**File:** `apps/client/src/layers/features/chat/ui/RunningAgentIndicator.tsx`

Show max 4 runners, then a `+N` badge (24x24px circle) for overflow. Badge has hover tooltip listing overflow agent descriptions with colored dots.

**Dependencies:** 2.3
**Parallel:** 4.2, 4.3

---

### Task 4.2 — Reduced motion and accessibility [small, medium]

**Files:** `agent-runner.css`, `RunningAgentIndicator.tsx`, `AgentRunner.tsx`

Verify `prefers-reduced-motion` disables CSS animations. Add `useReducedMotion()` from Motion for instant transitions. Ensure `role="status"`, `aria-live="polite"`, and `aria-label` attributes are correct.

**Dependencies:** 2.1, 2.2, 2.3
**Parallel:** 4.1, 4.3

---

### Task 4.3 — Error state handling [small, low]

**File:** `apps/client/src/layers/features/chat/ui/AgentRunner.tsx`

Verify error agents show X mark icon instead of checkmark. Same celebration flow (burst → error icon → exit). Add test case for error rendering.

**Dependencies:** 3.2
**Parallel:** 4.1, 4.2

---

## Summary

| Phase                            | Tasks  | Sizes        |
| -------------------------------- | ------ | ------------ |
| 1 — Core Hook + Static Indicator | 4      | 1S + 2M + 1M |
| 2 — Animated Running Figure      | 4      | 2S + 1M + 1S |
| 3 — Completion Celebrations      | 3      | 1S + 1L + 1M |
| 4 — Polish                       | 3      | 3S           |
| **Total**                        | **14** | 7S + 5M + 1L |

## Parallel Opportunities

- **Phase 1:** Task 1.4 (tests) can run in parallel with 1.2 and 1.3
- **Phase 2:** Tasks 2.1 (CSS) and 2.2 (component) can run in parallel; Tasks 2.3 and 2.4 can run in parallel
- **Phase 4:** All three tasks (4.1, 4.2, 4.3) can run in parallel

## New Files

| File                                            | LOC (est.) |
| ----------------------------------------------- | ---------- |
| `model/use-running-subagents.ts`                | ~80        |
| `model/__tests__/use-running-subagents.test.ts` | ~100       |
| `ui/RunningAgentIndicator.tsx`                  | ~120       |
| `ui/AgentRunner.tsx`                            | ~180       |
| `ui/AgentRunnerBurst.tsx`                       | ~40        |
| `ui/agent-runner.css`                           | ~100       |
| `ui/__tests__/RunningAgentIndicator.test.tsx`   | ~80        |

## Modified Files

| File                        | Change                             |
| --------------------------- | ---------------------------------- |
| `ui/ChatInputContainer.tsx` | +15 LOC (new prop, import, render) |
| `ui/ChatPanel.tsx`          | +5 LOC (hook call, prop pass)      |
