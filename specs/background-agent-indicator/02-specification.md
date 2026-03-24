---
slug: background-agent-indicator
number: 173
created: 2026-03-23
status: specified
---

# Background Agent Indicator

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-03-23
**Ideation:** `specs/background-agent-indicator/01-ideation.md`

---

## Overview

A persistent animated indicator in ChatInputContainer that shows running background agents (subagents) as tiny animated SVG running figures. Each agent gets a unique color, hover tooltips showing real-time agent details, and a per-agent completion celebration (particle burst → checkmark → slot collapse) when it finishes. The indicator bar appears when the first agent spawns and disappears when the last one completes.

Design is locked in from four rounds of HTML mockup iteration (see `mockups/running-figure-final.html`).

## Background / Problem Statement

When Claude Code dispatches background subagents (via the `Agent` tool with `run_in_background: true`), the only indication of their existence is a `SubagentBlock` rendered inline in the message stream. As the conversation continues, these blocks scroll off-screen and the user loses awareness of how many agents are still working, what they're doing, and when they complete.

This creates a gap in the "mission control" experience DorkOS aims to provide — the user should always know what their fleet is doing without scrolling.

## Goals

- Always-visible awareness of running background agents, regardless of scroll position
- Per-agent identity through unique colors and descriptions
- Real-time progress visibility (tool count, duration, last tool) via hover tooltips
- Joyful completion micro-interactions (particle burst → checkmark) that reward the user
- Zero new npm dependencies — CSS animations for the run cycle, Motion for enter/exit lifecycle

## Non-Goals

- Replacing or modifying the existing inline `SubagentBlock` rendering in messages
- Click-to-scroll-to-subagent behavior (potential follow-up)
- Adding a toggle preference to hide the indicator (can be added later if needed)
- Server-side or schema changes — all data already exists in `SubagentPart`
- Task/TodoList integration (separate system from subagents)

## Technical Dependencies

- **motion/react** (already installed) — `AnimatePresence`, `motion.div` for enter/exit transitions
- **@dorkos/shared/types** — `SubagentPart`, `SubagentStatus` types
- **CSS @keyframes** — running figure animation (no library needed)
- No new dependencies required

## Detailed Design

### Architecture

```
ChatPanel
  └─ useChatSession().messages ─────────────────────────┐
  └─ ChatInputContainer                                  │
       └─ RunningAgentIndicator                          │
            ├─ receives: runningAgents (derived from ────┘
            │    messages via useRunningSubagents hook)
            ├─ AgentRunner[] (max 4 visible)
            │    ├─ SVG running figure (CSS @keyframes)
            │    ├─ Hover tooltip (CSS-only)
            │    └─ Completion lifecycle (burst → check → exit)
            └─ Overflow badge ("+N" for 5+ agents)
```

### Data Flow

The key architectural decision is how `RunningAgentIndicator` gets access to the messages array, since `ChatInputContainer` currently does **not** receive messages as a prop.

**Approach: Pass `runningSubagents` down from ChatPanel.**

`ChatPanel` already has access to `messages` from `useChatSession()`. We derive the running subagents list at the `ChatPanel` level using the new `useRunningSubagents` hook, then pass the result down to `ChatInputContainer` as a new prop. This avoids threading the entire messages array through and keeps the derived state close to the data source.

```
useChatSession().messages
  → useRunningSubagents(messages) in ChatPanel
    → runningSubagents prop to ChatInputContainer
      → RunningAgentIndicator renders AgentRunner[]
```

### Component: `useRunningSubagents` Hook

**File:** `apps/client/src/layers/features/chat/model/use-running-subagents.ts`

```typescript
interface RunningAgent {
  taskId: string;
  description: string;
  status: 'running' | 'complete' | 'error';
  color: string; // CSS color value from AGENT_COLORS palette
  toolUses?: number;
  lastToolName?: string;
  durationMs?: number;
  summary?: string;
}

const AGENT_COLORS = [
  'hsl(210 80% 60%)', // blue
  'hsl(150 60% 50%)', // green
  'hsl(270 60% 65%)', // purple
  'hsl(36 90% 55%)', // amber
  'hsl(340 75% 60%)', // rose
] as const;

function useRunningSubagents(messages: ChatMessage[]): RunningAgent[];
```

**Implementation:**

1. `useMemo` scans all `messages[].parts` for entries where `part.type === 'subagent'`
2. Filters to `status === 'running'` (active agents only)
3. Assigns colors via round-robin from `AGENT_COLORS` based on the order subagents first appeared
4. Returns `RunningAgent[]` — empty array when no agents running

**Color assignment strategy:** Use a `useRef<Map<string, string>>` to persist taskId → color mappings across renders. When a new taskId appears, assign the next color in the palette (wrapping around). This ensures colors are stable — a given agent keeps its color even as others complete.

**Completion tracking:** The hook also returns agents that _just_ transitioned to `'complete'` or `'error'` status, keeping them in the array for a brief period (1.5s) to allow the celebration animation to play before removal. This is managed by tracking previous statuses in a `useRef` and using `setTimeout` to clear completed entries.

### Component: `RunningAgentIndicator`

**File:** `apps/client/src/layers/features/chat/ui/RunningAgentIndicator.tsx`

**Props:**

```typescript
interface RunningAgentIndicatorProps {
  agents: RunningAgent[];
}
```

**Behavior:**

- Renders nothing when `agents` is empty
- Wraps in `AnimatePresence` for bar enter/exit
- Bar enter: slide up from below with opacity fade (200ms, ease-out)
- Bar exit: slide down with opacity fade (200ms, ease-out)
- Layout: flex row with `gap: 0`, agents on left, label + stats on right
- Shows max 4 `AgentRunner` components; if more, shows `"+N"` overflow badge
- Label: `"N agent(s) running"` with aggregate stats (`"12 tools · 34s"`)

**Indicator bar styling:**

```
rounded-lg bg-[hsl(0_0%_6%)] border border-[hsl(0_0%_15%)]
px-2 py-1.5 flex items-center gap-2
```

### Component: `AgentRunner`

**File:** `apps/client/src/layers/features/chat/ui/AgentRunner.tsx`

**Props:**

```typescript
interface AgentRunnerProps {
  agent: RunningAgent;
  index: number; // for staggered animation-delay
}
```

**Lifecycle states (managed internally via useRef):**

1. **Running** — SVG figure animates with CSS @keyframes run cycle
2. **Completing** — particle burst plays, then runner morphs to checkmark
3. **Done** — slot collapses, component unmounts via AnimatePresence

**SVG Running Figure (V3D Compact, 22x24px):**

The SVG uses a `viewBox="0 0 22 24"` with these elements:

- Head: `<circle cx="11" cy="4.5" r="2.8">`
- Eye highlight: `<circle cx="12.3" cy="3.7" r="0.6" fill="hsl(0 0% 100% / 0.7)">`
- Body: `<ellipse cx="11" cy="10.5" rx="2.5" ry="3.5">`
- Jointed limbs: `<line>` segments grouped in `<g>` with CSS `transform-origin` at each joint

All elements use `fill: var(--c)` or `stroke: var(--c)` where `--c` is the agent's assigned color.

**CSS animation classes:**

- `.r-all` — whole body bounce (0.36s cycle, translateY + rotate)
- `.r-rt`, `.r-rs` — right thigh, right shin rotation
- `.r-lt`, `.r-ls` — left thigh, left shin rotation (opposite phase)
- `.r-rua`, `.r-rfa` — right upper arm, right forearm
- `.r-lua`, `.r-lfa` — left upper arm, left forearm (opposite phase)

Each joint rotates from its anatomical pivot point via `transform-origin`.

**Staggered timing:** Each runner gets `animation-delay: ${index * 0.09}s` applied to all animated groups, so runners are slightly out of phase.

**Hover tooltip (CSS-only):**

A `<div>` positioned absolutely above the runner, shown on `:hover` with `opacity` transition:

- Title: agent description (bold, with colored dot)
- Meta: tool count + duration (monospace)
- Last tool: tool name (dimmed monospace)
- Arrow: CSS triangle pointing down

**Completion lifecycle:**

1. When `agent.status` changes from `'running'` to `'complete'`/`'error'` (detected via `useRef` tracking previous status):
2. Set internal state to `'completing'`
3. Render `AgentRunnerBurst` (particle burst, 350ms)
4. After 350ms: swap SVG runner for checkmark SVG (scale-in animation, 300ms)
5. After 800ms more: begin exit — Motion `AnimatePresence` collapses slot

### Component: `AgentRunnerBurst`

**File:** `apps/client/src/layers/features/chat/ui/AgentRunnerBurst.tsx`

A pure presentational component — 8 `<span>` elements absolutely positioned at center, each with a CSS animation that translates outward in a different direction and fades to opacity 0. Uses the agent's `--c` color for particle color.

**CSS:**

```css
@keyframes burst-particle {
  0% {
    transform: translate(0, 0) scale(1);
    opacity: 1;
  }
  100% {
    transform: translate(var(--bx), var(--by)) scale(0);
    opacity: 0;
  }
}
```

Each span gets unique `--bx`/`--by` values and staggered `animation-delay` (0–0.09s range).

### Slot Transitions (enter/exit per-agent)

Using Motion's `AnimatePresence` with individual wrapper `motion.div` per agent:

**Enter:**

```typescript
initial={{ width: 0, opacity: 0 }}
animate={{ width: 22, opacity: 1 }}
transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
```

**Exit:**

```typescript
exit={{ width: 0, opacity: 0 }}
transition={{ duration: 0.35, ease: [0.55, 0, 1, 0.45] }}
```

The width animation on the slot container naturally causes flex siblings to reposition smoothly.

### ChatInputContainer Integration

**File:** `apps/client/src/layers/features/chat/ui/ChatInputContainer.tsx`

Add a new prop:

```typescript
/** Running background agents to display in the indicator. */
runningAgents: RunningAgent[];
```

Insert between `ChatInput` and `ChatStatusSection` in the normal mode JSX:

```typescript
<ChatInput ... />

{runningAgents.length > 0 && (
  <RunningAgentIndicator agents={runningAgents} />
)}

<ChatStatusSection ... />
```

### ChatPanel Wiring

**File:** `apps/client/src/layers/features/chat/ui/ChatPanel.tsx`

```typescript
const { messages, ... } = useChatSession(...);
const runningAgents = useRunningSubagents(messages);

// Pass down to ChatInputContainer:
<ChatInputContainer
  runningAgents={runningAgents}
  ... existing props
/>
```

### File Organization

```
apps/client/src/layers/features/chat/
├── model/
│   ├── use-running-subagents.ts          (NEW ~80 LOC)
│   └── __tests__/
│       └── use-running-subagents.test.ts (NEW ~100 LOC)
├── ui/
│   ├── RunningAgentIndicator.tsx         (NEW ~120 LOC)
│   ├── AgentRunner.tsx                   (NEW ~180 LOC)
│   ├── AgentRunnerBurst.tsx              (NEW ~40 LOC)
│   ├── agent-runner.css                  (NEW ~100 LOC — @keyframes)
│   ├── ChatInputContainer.tsx            (MODIFIED +15 LOC)
│   ├── ChatPanel.tsx                     (MODIFIED +5 LOC)
│   └── __tests__/
│       └── RunningAgentIndicator.test.tsx (NEW ~80 LOC)
└── index.ts                              (MODIFIED — export hook if needed)
```

### CSS Animation File

**File:** `apps/client/src/layers/features/chat/ui/agent-runner.css`

All `@keyframes` for the running cycle, particle burst, and checkmark scale-in live in a dedicated CSS file imported by `AgentRunner.tsx`. This keeps the component file focused on structure and lifecycle logic.

The CSS uses `@media (prefers-reduced-motion: reduce)` to disable all running and burst animations, showing a static standing figure instead.

## User Experience

### When agents are running

1. User sends a message that spawns background agents
2. Within ~100ms of the first `subagent_started` SSE event, the indicator bar slides up between the input and status bar
3. A tiny colored running figure appears with a slot-unfold animation
4. As more agents spawn, additional figures appear to the right with staggered timing
5. Hovering any figure shows a tooltip with the agent's description, tool count, elapsed time, and last tool used
6. The tooltip data updates live as `subagent_progress` events arrive

### When agents complete

1. When an agent finishes (`subagent_done`), its figure triggers a celebration:
   - 8 colored particles burst outward from the figure (0.35s)
   - The running figure morphs into a checkmark (0.3s scale-in)
   - The checkmark holds for 0.8s (so the user notices the success)
   - The slot collapses smoothly (0.35s width transition)
2. Remaining figures slide together to fill the gap
3. The count label updates ("2 agents running" → "1 agent running")
4. When the last agent completes and its celebration finishes, the entire indicator bar slides out

### Edge cases

- **5+ agents:** First 4 shown as figures, rest collapsed into a "+N" badge with tooltip listing overflow agents
- **Agent errors:** Same celebration flow but with an error icon instead of checkmark (uses `agent.status === 'error'`)
- **Rapid completions:** Each agent's celebration runs independently; staggered exits prevent visual chaos
- **Reduced motion:** Static figure shown instead of running animation; enter/exit still uses opacity fade (no motion)
- **Obsidian embedded mode:** Works identically — ChatInputContainer renders in both modes

## Testing Strategy

### Unit Tests: `use-running-subagents.test.ts`

```typescript
describe('useRunningSubagents', () => {
  it('returns empty array when no messages have subagent parts', () => {
    // Purpose: Baseline — indicator should not render when no subagents exist
  });

  it('returns running subagents extracted from message parts', () => {
    // Purpose: Verifies core data derivation from message parts
    // Setup: messages with SubagentPart { status: 'running' }
    // Assert: returns RunningAgent with correct fields
  });

  it('excludes completed subagents after celebration timeout', () => {
    // Purpose: Completed agents should disappear after 1.5s
    // Setup: status changes from 'running' to 'complete'
    // Assert: agent stays for 1.5s (celebration), then removed
  });

  it('assigns stable colors per taskId', () => {
    // Purpose: Agent color shouldn't change when other agents complete
    // Setup: 3 agents, remove middle one
    // Assert: remaining agents keep their original colors
  });

  it('assigns colors round-robin from AGENT_COLORS', () => {
    // Purpose: Each new agent gets the next color in the palette
    // Setup: spawn 6 agents (more than palette size)
    // Assert: colors cycle through the palette
  });

  it('scans all messages, not just the latest', () => {
    // Purpose: Agents spawned in earlier messages still show
    // Setup: multiple messages, subagent in first message
    // Assert: still returned in running list
  });
});
```

### Component Tests: `RunningAgentIndicator.test.tsx`

```typescript
describe('RunningAgentIndicator', () => {
  it('renders nothing when agents array is empty', () => {
    // Purpose: No DOM output = no indicator bar
  });

  it('renders agent figures for each running agent', () => {
    // Purpose: Each agent in the array produces a visible figure
    // Assert: correct number of SVG elements with correct colors
  });

  it('shows overflow badge when more than 4 agents', () => {
    // Purpose: Overflow handling for 5+ agents
    // Setup: 6 running agents
    // Assert: 4 SVG figures + "+2" badge visible
  });

  it('displays aggregate stats in the label', () => {
    // Purpose: Summary line shows total tool count and max duration
    // Assert: "3 agents running" and "12 tools · 34s" visible
  });

  it('shows tooltip on hover with agent details', () => {
    // Purpose: Tooltip surfaces SubagentPart data
    // Setup: hover over first agent figure
    // Assert: description, tool count, last tool visible in tooltip
  });
});
```

### Mocking Strategy

- No Transport mock needed — the hook operates on `ChatMessage[]` passed as prop
- Create test helpers for building `ChatMessage` arrays with `SubagentPart` entries
- Use `vi.useFakeTimers()` for testing completion timeout behavior
- Use `@testing-library/react` `renderHook` for hook tests

## Performance Considerations

- **CSS @keyframes for run cycle:** GPU-composited transforms (translateY, rotate). Zero JS cost per frame. 5 runners with 10 animated segments each = 50 CSS animations — well within browser capability.
- **useMemo for derivation:** `useRunningSubagents` re-scans messages only when the messages array reference changes (React's referential equality check). During streaming, this triggers on each `updateAssistantMessage` call, but the scan is O(n) over parts and extremely fast.
- **AnimatePresence for enter/exit:** Only 4-5 Motion instances for slot animations — negligible overhead compared to the existing message list animations.
- **Tooltip rendering:** CSS-only (opacity + transform transition), no React state changes on hover.

## Security Considerations

No security implications — this feature only reads and displays data already present in the client-side message stream. No new API calls, no user input handling, no data persistence.

## Accessibility

- **Reduced motion:** `@media (prefers-reduced-motion: reduce)` disables all running and burst animations. Global `<MotionConfig reducedMotion="user">` handles Motion enter/exit animations. Static standing figure shown in reduced-motion mode.
- **Screen readers:** Indicator bar has `role="status"` and `aria-live="polite"` to announce agent count changes. Individual figures have `aria-label` with agent description.
- **Keyboard:** Tooltips are hover-only (informational, not interactive). The indicator itself is not focusable — it's a passive status display.

## Documentation

- Update `contributing/animations.md` to document the running figure animation pattern as a reference example of CSS @keyframes in SVG
- No user-facing docs needed — the feature is self-explanatory (figures appear when agents run)

## Implementation Phases

### Phase 1: Core Hook + Static Indicator

1. Create `use-running-subagents.ts` hook with color assignment and completion tracking
2. Create `RunningAgentIndicator.tsx` with basic layout (count label, stats)
3. Wire through `ChatPanel` → `ChatInputContainer`
4. Write hook unit tests
5. Verify data flows correctly during real subagent streaming

### Phase 2: Animated Running Figure

1. Create `agent-runner.css` with all @keyframes for V3D runner
2. Create `AgentRunner.tsx` with SVG figure and CSS animation classes
3. Add slot-unfold enter/exit transitions via AnimatePresence
4. Add hover tooltip (CSS-only)
5. Test with multiple concurrent agents

### Phase 3: Completion Celebrations

1. Create `AgentRunnerBurst.tsx` particle burst component
2. Implement completion lifecycle in AgentRunner (burst → check → exit)
3. Add checkmark SVG and scale-in animation
4. Fine-tune timing (burst 350ms → check 300ms → hold 800ms → exit 350ms)
5. Write component render tests

### Phase 4: Polish

1. Overflow badge for 5+ agents with tooltip
2. Reduced motion fallback (static figure)
3. Error state handling (error icon instead of checkmark)
4. Test in Obsidian embedded mode
5. Verify no regressions in existing ChatInputContainer behavior

## Open Questions

None — all decisions were resolved during ideation (see Section 6 of `01-ideation.md`).

## Related ADRs

- **ADR-0137:** `subagent-part-in-message-part-union` — Established `SubagentPart` as a first-class discriminant in `MessagePartSchema`, which this feature consumes

## References

- **Ideation:** `specs/background-agent-indicator/01-ideation.md`
- **Design mockups:** `mockups/running-figure-final.html` (interactive demo with all transitions)
- **Runner geometry:** `mockups/running-figure-v3.html` (V3D compact with jointed limbs)
- **Character drafts:** `mockups/running-figure-v2.html` (biomechanics research applied)
- **All options:** `mockups/background-agent-indicator.html` (original 6 indicator designs)
- **Biomechanics research:** `research/20260323_running_cycle_biomechanics_animation.md`
- **Animation patterns:** `contributing/animations.md`
- **SubagentPart schema:** `packages/shared/src/schemas.ts` lines 548-566
