---
title: 'Background Agent Indicator — SVG Running Figures, AnimatePresence Slots, Particle Burst'
date: 2026-03-23
type: external-best-practices
status: active
tags:
  [
    animation,
    svg,
    subagent,
    motion-dev,
    AnimatePresence,
    particle-burst,
    tooltip,
    chat-ui,
    background-agent-indicator,
  ]
feature_slug: background-agent-indicator
searches_performed: 12
sources_count: 28
---

# Background Agent Indicator — SVG Running Figures, AnimatePresence Slots, Particle Burst

## Research Summary

This report covers the five concrete implementation questions for the background-agent-indicator feature: (1) SVG running figure animation in React using CSS keyframes with `transform-origin`; (2) AnimatePresence slot-width patterns for a horizontal flex container where agent indicators enter/exit; (3) particle burst celebration with morph-to-checkmark timing; (4) lightweight tooltip patterns; and (5) deriving running agents from the existing `SubagentPart` message stream. The existing DorkOS codebase already has all necessary data — `SubagentPart` in `packages/shared/src/schemas.ts` with `status: 'running' | 'complete' | 'error'`, `taskId`, `description`, `toolUses`, and `durationMs`. The `ChatInputContainer.tsx` already uses Motion and `AnimatePresence`. The recommended approach uses: pure CSS `@keyframes` on SVG groups (not Motion) for the running animation, Motion `animate={{ width: 0 / "auto" }}` with `overflow: hidden` for the slot-collapse, `react-confetti-explosion` (CSS-only, no canvas) for the burst, Radix `Tooltip` (already in the DorkOS shared UI) for hover content, and a `usePrevious`-pattern `useRef` to detect status transitions.

---

## Key Findings

### 1. SVG Running Figure Animation

**Recommended approach: pure CSS `@keyframes` on SVG `<g>` groups, not Motion.**

The running figure consists of a minimal SVG (16×16px or 20×20px) with named groups: `<g id="body">`, `<g id="left-leg">`, `<g id="right-leg">`, `<g id="left-arm">`, `<g id="right-arm">`. Each limb group rotates around its joint using `transform-origin`.

**The key SVG construction rule**: SVG `transform-origin` for inline SVG within HTML5 is now properly supported in all modern browsers (Chrome 64+, Firefox 70+, Safari 14+) using the CSS `transform-origin` property on SVG elements directly — not the SVG-native `transform-origin` attribute. The limb's pivot should be at the top of the limb (the joint), so the SVG path for a leg should be drawn downward from the origin.

**CSS keyframe structure for a running figure:**

```css
/* Single animation cycle = one full stride (both legs complete) */
@keyframes run-left-leg {
  0%,
  100% {
    transform: rotate(30deg);
  }
  50% {
    transform: rotate(-30deg);
  }
}

@keyframes run-right-leg {
  0%,
  100% {
    transform: rotate(-30deg);
  }
  50% {
    transform: rotate(30deg);
  }
}

/* Arms swing opposite to legs */
@keyframes run-left-arm {
  0%,
  100% {
    transform: rotate(-25deg);
  }
  50% {
    transform: rotate(25deg);
  }
}

@keyframes run-right-arm {
  0%,
  100% {
    transform: rotate(25deg);
  }
  50% {
    transform: rotate(-25deg);
  }
}

/* Body bob — slight up/down vertical movement */
@keyframes run-body-bob {
  0%,
  100% {
    transform: translateY(0px);
  }
  25%,
  75% {
    transform: translateY(-1px);
  }
  50% {
    transform: translateY(0px);
  }
}
```

**Animation application in React:**

```tsx
// Agent.tsx — the SVG is an inline component, NOT an img src
// This allows CSS @keyframes to target the SVG groups

const AGENT_COLORS = [
  '#6366f1', // indigo
  '#f59e0b', // amber
  '#10b981', // emerald
  '#ef4444', // red
  '#8b5cf6', // violet
  '#3b82f6', // blue
];

interface RunningAgentFigureProps {
  color: string;
  /** Animation speed in seconds per stride cycle. Default: 0.6 */
  speed?: number;
}

export function RunningAgentFigure({ color, speed = 0.6 }: RunningAgentFigureProps) {
  return (
    <svg
      width="16"
      height="20"
      viewBox="0 0 16 20"
      style={{ '--agent-color': color } as React.CSSProperties}
      aria-hidden="true"
    >
      <style>{`
        .agent-figure-body {
          animation: run-body-bob ${speed}s ease-in-out infinite;
          transform-origin: 8px 8px;
        }
        .agent-figure-left-leg {
          animation: run-left-leg ${speed}s ease-in-out infinite;
          transform-origin: 8px 12px;
        }
        .agent-figure-right-leg {
          animation: run-right-leg ${speed}s ease-in-out infinite;
          transform-origin: 8px 12px;
        }
        .agent-figure-left-arm {
          animation: run-left-arm ${speed}s ease-in-out infinite;
          transform-origin: 5px 8px;
        }
        .agent-figure-right-arm {
          animation: run-right-arm ${speed}s ease-in-out infinite;
          transform-origin: 11px 8px;
        }
        @keyframes run-left-leg  { 0%,100%{transform:rotate(30deg)}  50%{transform:rotate(-30deg)} }
        @keyframes run-right-leg { 0%,100%{transform:rotate(-30deg)} 50%{transform:rotate(30deg)} }
        @keyframes run-left-arm  { 0%,100%{transform:rotate(-25deg)} 50%{transform:rotate(25deg)} }
        @keyframes run-right-arm { 0%,100%{transform:rotate(25deg)}  50%{transform:rotate(-25deg)} }
        @keyframes run-body-bob  { 0%,25%,75%,100%{transform:translateY(0)} 50%{transform:translateY(-1px)} }
      `}</style>

      {/* Head */}
      <circle cx="8" cy="4" r="2.5" fill="var(--agent-color)" />

      {/* Body — moves with bob */}
      <g className="agent-figure-body">
        <line
          x1="8"
          y1="6.5"
          x2="8"
          y2="12"
          stroke="var(--agent-color)"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </g>

      {/* Left arm */}
      <g className="agent-figure-left-arm">
        <line
          x1="8"
          y1="8"
          x2="4"
          y2="10.5"
          stroke="var(--agent-color)"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </g>

      {/* Right arm */}
      <g className="agent-figure-right-arm">
        <line
          x1="8"
          y1="8"
          x2="12"
          y2="10.5"
          stroke="var(--agent-color)"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </g>

      {/* Left leg */}
      <g className="agent-figure-left-leg">
        <line
          x1="8"
          y1="12"
          x2="5"
          y2="17"
          stroke="var(--agent-color)"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </g>

      {/* Right leg */}
      <g className="agent-figure-right-leg">
        <line
          x1="8"
          y1="12"
          x2="11"
          y2="17"
          stroke="var(--agent-color)"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}
```

**CSS custom property color pattern:** The `style={{ '--agent-color': color }}` inline style sets the CSS variable on the SVG element. All `fill` and `stroke` attributes inside the SVG reference `var(--agent-color)`. This is supported in all modern browsers — inline `style` on SVG elements passes through to CSS, so child elements can inherit the custom property. **Important**: Remove any `fill` attributes from the SVG paths that are hardcoded — inline `fill` attributes have higher specificity than CSS custom properties and will override them.

**Performance with 4-5 simultaneous animations:** Pure CSS keyframe animations are always on the compositor thread when they only animate `transform` and `opacity`. Each running figure runs its own keyframe independently with no JavaScript involvement. 4-5 simultaneous CSS animations on 16x16 SVG elements with 5 keyframe animations each is trivially cheap — modern compositors handle hundreds of such animations at 60fps. The concern threshold is around 50+ simultaneous complex animations.

**Why not Motion for the running animation:** Motion's `useAnimate` or `animate()` imperative API is overkill for a looping CSS keyframe. The running cycle is a pure periodic loop — CSS `animation: ... infinite` is the correct and most performant primitive. Motion adds value for spring physics and interruption, but running animation never needs to be interrupted or reversed.

**`@media (prefers-reduced-motion)` compliance:**

```css
@media (prefers-reduced-motion: reduce) {
  .agent-figure-left-leg,
  .agent-figure-right-leg,
  .agent-figure-left-arm,
  .agent-figure-right-arm,
  .agent-figure-body {
    animation: none;
  }
}
```

With reduced motion, the figure becomes a static silhouette — still visible and colored, just not animated.

---

### 2. AnimatePresence Slot-Width Pattern for Horizontal Flex Container

**The pattern: outer wrapper animates `width: 0 → "auto"`, inner div holds overflow.**

This is the "slot-collapse" pattern. Each agent indicator occupies a horizontal slot in the container. When an agent appears, the slot expands from 0. When it exits (post-celebration), the slot collapses to 0, and the remaining indicators slide together smoothly.

```tsx
// BackgroundAgentIndicatorBar.tsx
// Lives above the ChatInput in the normal mode div of ChatInputContainer

function AgentSlot({
  agent,
  color,
  isCompleting, // true while celebration plays before exit
  onCelebrationDone,
}: AgentSlotProps) {
  return (
    // Outer motion.div handles width slot — overflow:hidden clips the content
    // during width animation so it doesn't bleed into adjacent slots
    <motion.div
      key={agent.taskId}
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 'auto', opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{
        width: { type: 'spring', stiffness: 300, damping: 28 },
        opacity: { duration: 0.15 },
      }}
      style={{ overflow: 'hidden' }}
      className="flex-shrink-0"
    >
      {/* Inner div — actual content width, not subject to clip */}
      <div className="relative px-1">
        {isCompleting ? (
          <AgentCompletionCelebration color={color} onDone={onCelebrationDone} />
        ) : (
          <AgentRunningFigure color={color} />
        )}
      </div>
    </motion.div>
  );
}

// The bar itself
export function BackgroundAgentIndicatorBar({ agents }: { agents: SubagentPart[] }) {
  return (
    <AnimatePresence initial={false}>
      {agents.map((agent, i) => (
        <AgentSlot
          key={agent.taskId}
          agent={agent}
          color={AGENT_COLORS[i % AGENT_COLORS.length]}
          ...
        />
      ))}
    </AnimatePresence>
  );
}
```

**Why `width: 0 → "auto"` not `layout` prop:** The `layout` prop is ideal for elements that reposition due to sibling changes. For an element that should animate its own size from zero to content size, explicit `width: 0 → "auto"` animation is cleaner and more predictable. The `layout` prop would fight with the initial mount animation and complicate the exit timing.

**The two-div rule (critical):** The outer `motion.div` with `overflow: hidden` clips content during the width animation. Without it, the running figure SVG bleeds outside its slot width during the animation. The inner `div` holds the true content at natural size. This is the same outer/inner pattern required for height animation.

**Gap handling in flex container:** Flex `gap` on the parent container does NOT automatically animate when slots enter/exit. Options:

- Use `px-1` padding on the inner div (preferred — the gap is baked into each slot)
- Or use `AnimatePresence mode="popLayout"` with `layout` on siblings (more complex, not needed here)

**`mode="popLayout"` vs default:** `mode="popLayout"` is for when an exiting element needs its position animated while siblings reflow. For agent indicators, we don't need this — the exiting slot's width collapses, and the remaining slots slide together naturally via the width spring. Default mode is fine.

**Spring values for the slot animation:**

```typescript
// Recommended: snappy expand, slightly slower collapse
// Expand:
{ width: { type: 'spring', stiffness: 320, damping: 28 } }

// Collapse (in exit prop — use a slightly lower stiffness for more natural feel):
// exit={{ width: 0, opacity: 0, transition: { width: { type: 'spring', stiffness: 240, damping: 24 } } }}
```

---

### 3. Particle Burst Celebration with Morph-to-Checkmark Timing

**Recommended approach: `react-confetti-explosion` for the burst, then a Motion-animated checkmark SVG, then slot exit.**

`react-confetti-explosion` is:

- Pure CSS animations — zero canvas, zero requestAnimationFrame
- ~2KB (not worth adding a canvas library for this)
- Positioned absolutely via `createPortal` to avoid layout disruption
- Configurable: `particleCount`, `width`, `duration`, `colors`

**The full celebration sequence:**

```tsx
// AgentCompletionCelebration.tsx
// Timing: 0ms = mount → 400ms = burst peaks → 800ms = show checkmark → 1400ms = checkmark hold → 1600ms = call onDone

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import ConfettiExplosion from 'react-confetti-explosion';

type Phase = 'burst' | 'checkmark' | 'done';

interface AgentCompletionCelebrationProps {
  color: string;
  onDone: () => void;
}

export function AgentCompletionCelebration({ color, onDone }: AgentCompletionCelebrationProps) {
  const [phase, setPhase] = useState<Phase>('burst');

  useEffect(() => {
    // Burst plays for 800ms, then transition to checkmark
    const toCheckmark = setTimeout(() => setPhase('checkmark'), 800);
    // Checkmark holds for 600ms, then signal done (triggers slot exit)
    const toDone = setTimeout(() => {
      setPhase('done');
      onDone();
    }, 1400);

    return () => {
      clearTimeout(toCheckmark);
      clearTimeout(toDone);
    };
  }, [onDone]);

  return (
    <div className="relative flex items-center justify-center" style={{ width: 16, height: 20 }}>
      {/* Confetti burst — renders for the first 800ms then unmounts */}
      {phase === 'burst' && (
        <ConfettiExplosion
          force={0.3}
          duration={700}
          particleCount={12}
          width={80}
          colors={[color, '#ffffff', `${color}88`]}
        />
      )}

      {/* Checkmark fades in after burst */}
      <AnimatePresence>
        {(phase === 'checkmark' || phase === 'done') && (
          <motion.svg
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 400, damping: 20 }}
            width="14"
            height="14"
            viewBox="0 0 14 14"
            aria-hidden="true"
          >
            <motion.path
              d="M2 7 L5.5 10.5 L12 3"
              stroke={color}
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.3, ease: 'easeOut', delay: 0.05 }}
            />
          </motion.svg>
        )}
      </AnimatePresence>
    </div>
  );
}
```

**Why `react-confetti-explosion` and not custom particles:** The feature calls for a small burst on a ~16x20px element. A hand-rolled particle system adds 50-100 lines of requestAnimationFrame code that provides no meaningful advantage over a well-maintained CSS library. `react-confetti-explosion` weighs ~2KB, is pure CSS (compositor thread), and is used in production by many tools.

**The `pathLength` morph:** Motion's `pathLength` animation (0 → 1) draws the checkmark stroke progressively. This is the "morph from particle to checkmark" effect — the confetti explodes, then a checkmark draws itself in. This requires the path `d` attribute to be a single continuous stroke (not two separate paths).

**Timing rationale:**

- 800ms burst → feels like a moment of celebration without being intrusive
- 300ms checkmark draw-in → quick enough to feel snappy
- 600ms checkmark hold → enough to read and comprehend completion
- Total: ~1400ms before `onDone()` triggers slot collapse

**Performance with multiple simultaneous completions:** If 3 agents complete simultaneously, 3 confetti bursts fire at once. Each burst is ~12 CSS-animated particles. 36 CSS particles at once is completely safe. The concern threshold for CSS particle animations is ~500+ particles on low-end devices.

---

### 4. Tooltip Patterns

**Recommended approach: Radix `Tooltip` (already in the DorkOS shared UI layer), not CSS-only.**

**Why not CSS-only tooltips:** CSS-only tooltips (`[data-tooltip]:hover::after { content: attr(data-tooltip); position: absolute; ... }`) have two critical problems:

1. They cannot be positioned above the element reliably when the element is at the top of a flex container — the tooltip will clip outside the container boundary without Portal.
2. They cannot contain structured content (agent name + tool count + duration) — only plain text.

**Radix `Tooltip` advantages:**

- Already installed and used across DorkOS shared UI
- Positions via a Portal to avoid clipping
- Handles collision detection (flips from top to bottom if near viewport edge)
- `--radix-tooltip-content-transform-origin` CSS custom property enables animation from the correct origin
- Zero additional dependencies

**Tooltip content for running agents:**

```tsx
import { Tooltip, TooltipContent, TooltipTrigger } from '@/layers/shared/ui';

function AgentIndicatorWithTooltip({ agent, color }: { agent: SubagentPart; color: string }) {
  const toolText = agent.toolUses
    ? `${agent.toolUses} tool ${agent.toolUses === 1 ? 'call' : 'calls'}`
    : null;
  const durationText = agent.durationMs ? formatDuration(agent.durationMs) : null;
  const subtitleParts = [toolText, durationText].filter(Boolean);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`Background agent: ${agent.description}`}
          className="cursor-default"
        >
          <RunningAgentFigure color={color} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="max-w-48">
        <p className="truncate text-xs font-medium">{agent.description}</p>
        {subtitleParts.length > 0 && (
          <p className="text-muted-foreground mt-0.5 text-xs">{subtitleParts.join(' · ')}</p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
```

**Tooltip update behavior:** Radix `Tooltip` content is reactive — because `agent.toolUses` and `agent.durationMs` are props flowing down from React state, the tooltip body re-renders whenever they change. No special live-update handling needed. The user sees the latest tool count and duration each time they hover.

**Tooltip provider:** Ensure `<TooltipProvider>` wraps the feature. It already exists in the DorkOS app shell — no additional setup needed.

---

### 5. Deriving Running Agents from the Message Stream

**The data is already in the message parts.** The stream event handlers in `stream-tool-handlers.ts` already maintain `SubagentPart` entries in `currentPartsRef` with `status: 'running' | 'complete' | 'error'`. The `ChatPanel` / `ChatInputContainer` already receives `messages` — filtering for running subagents is a straightforward selector.

**Filtering active subagents:**

```typescript
// In a hook: useRunningSubagents.ts
// Placed in features/chat/model/

import { useMemo, useRef } from 'react';
import type { ChatMessage } from './chat-types';
import type { SubagentPart } from '@dorkos/shared/types';

interface RunningAgent extends SubagentPart {
  /** Unique color assigned to this agent for the indicator. */
  color: string;
}

const AGENT_COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#3b82f6'];

/**
 * Extract currently-running subagent parts from the message list.
 * Returns a stable list that persists taskId → color assignment across re-renders.
 */
export function useRunningSubagents(messages: ChatMessage[]): RunningAgent[] {
  // Stable color assignment — taskId → color index
  const colorMapRef = useRef<Map<string, string>>(new Map());
  let colorIndex = 0;

  const runningParts = useMemo(() => {
    const parts: SubagentPart[] = [];
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;
      for (const part of msg.parts ?? []) {
        if (part.type === 'subagent' && part.status === 'running') {
          parts.push(part);
        }
      }
    }
    return parts;
  }, [messages]);

  return useMemo(() => {
    return runningParts.map((part) => {
      if (!colorMapRef.current.has(part.taskId)) {
        colorMapRef.current.set(part.taskId, AGENT_COLORS[colorIndex % AGENT_COLORS.length]);
      }
      colorIndex++;
      return { ...part, color: colorMapRef.current.get(part.taskId)! };
    });
  }, [runningParts]);
}
```

**Detecting status transitions for the celebration:**

The `usePrevious` pattern with `useRef` is the correct approach. Detect when a `SubagentPart` transitions from `running` → `complete`:

```typescript
// useAgentCompletions.ts
// Returns a Set of taskIds that JUST completed this render cycle

import { useRef } from 'react';
import type { SubagentPart } from '@dorkos/shared/types';

/**
 * Returns the Set of taskIds that transitioned to 'complete' since the last render.
 * Used to trigger the completion celebration exactly once per agent.
 */
export function useAgentCompletions(allSubagents: SubagentPart[]): Set<string> {
  // Map of taskId → previous status, updated after each render
  const prevStatusRef = useRef<Map<string, string>>(new Map());

  const justCompleted = new Set<string>();

  for (const part of allSubagents) {
    const prev = prevStatusRef.current.get(part.taskId);
    if (prev === 'running' && part.status === 'complete') {
      justCompleted.add(part.taskId);
    }
  }

  // Update previous status map for next render
  // This runs synchronously during render — it's intentionally NOT in a useEffect
  // because we need the comparison to happen before we return the justCompleted set.
  for (const part of allSubagents) {
    prevStatusRef.current.set(part.taskId, part.status);
  }

  return justCompleted;
}
```

**Why `useRef` instead of `useEffect` + `useState` for transition detection:**

`useState` for transition detection creates a 2-render cycle: render 1 detects the transition in an effect, sets state, render 2 shows the result. This creates a visible delay. The `useRef` pattern compares within the render phase itself — the first render that sees `status: 'complete'` on a previously-`running` agent returns it in `justCompleted`. No extra render needed.

**Including just-completed agents in the indicator bar:**

The indicator bar should show the celebration for agents that have completed (not just running ones). The correct data source is all subagents where `status === 'running'` OR (status === 'complete' AND taskId is in the celebrating Set):

```typescript
// In BackgroundAgentIndicatorBar or its parent hook:
const allSubagents = useMemo(() => {
  // Collect all subagent parts from all messages
  const parts: SubagentPart[] = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const part of msg.parts ?? []) {
      if (part.type === 'subagent') parts.push(part);
    }
  }
  return parts;
}, [messages]);

const justCompleted = useAgentCompletions(allSubagents);

// Visible in indicator: running agents + agents in their celebration phase
const [celebratingSet, setCelebratingSet] = useState<Set<string>>(new Set());

// When justCompleted has new taskIds, add them to celebratingSet
useEffect(() => {
  if (justCompleted.size > 0) {
    setCelebratingSet((prev) => {
      const next = new Set(prev);
      justCompleted.forEach((id) => next.add(id));
      return next;
    });
  }
}, [justCompleted]);

const visibleAgents = allSubagents.filter(
  (p) => p.status === 'running' || celebratingSet.has(p.taskId)
);

// When a celebration finishes, remove from celebratingSet
// This triggers the slot exit animation
const handleCelebrationDone = useCallback((taskId: string) => {
  setCelebratingSet((prev) => {
    const next = new Set(prev);
    next.delete(taskId);
    return next;
  });
}, []);
```

---

## Detailed Analysis

### Component Architecture (FSD-compliant)

Given DorkOS's FSD layers, the indicator slots neatly into the existing structure:

```
features/chat/
├── ui/
│   ├── ChatInputContainer.tsx        ← add <BackgroundAgentIndicatorBar> above ChatInput
│   ├── BackgroundAgentIndicatorBar.tsx  ← new: the flex container + AnimatePresence
│   ├── AgentIndicatorSlot.tsx           ← new: single slot (width animation + tooltip)
│   ├── RunningAgentFigure.tsx           ← new: SVG running figure component
│   └── AgentCompletionCelebration.tsx   ← new: burst + checkmark sequence
└── model/
    └── use-background-agents.ts         ← new: hook combining all derivation logic
```

**Where in `ChatInputContainer`:** The indicator bar should render above the `ChatInput` in the `normal` mode div, between `QueuePanel` and `ChatInput`. It is only visible while `messages` contains running subagents, so zero DOM impact when no agents are active.

```tsx
// In ChatInputContainer.tsx, inside the "normal" mode div:
{/* Background agent indicator — only renders when subagents are active */}
<BackgroundAgentIndicatorBar messages={messages} />

{/* existing: */}
<ChatInput ... />
<ChatStatusSection ... />
```

**`messages` prop addition:** `ChatInputContainer` currently does not receive `messages`. The cleanest approach is to add it as a prop (it's already available in `ChatPanel` which owns both state and the container). Alternative: a Zustand selector on the message store — but prop-passing is simpler and keeps the component testable.

### Full Slot Lifecycle State Machine

```
IDLE          → subagent.status === 'running' arrives
  ↓ (agent enters AnimatePresence)
RUNNING       → slot expands (width: 0 → auto), RunningAgentFigure shows
  ↓ (subagent.status transitions to 'complete')
CELEBRATING   → slot stays same width, celebration component renders
  ↓ (800ms burst + 600ms checkmark = 1400ms total)
DONE          → onCelebrationDone() removes from celebratingSet
  ↓ (AnimatePresence exit)
EXITED        → slot collapses (width: auto → 0)
```

### Integration with Existing `ChatInputContainer` Animation

`ChatInputContainer.tsx` already wraps its content in `AnimatePresence mode="wait"` for the normal/interactive mode crossfade. The `BackgroundAgentIndicatorBar` should be inside the "normal" mode's `motion.div` — it will correctly enter/exit with that transition.

The `ScanLine` that shows during streaming is positioned at the top edge of the container. The indicator bar is inside the content flow. No z-index conflicts.

### Color Assignment Strategy

**Don't derive color from taskId hash** — use a sequential assignment stored in `useRef`. Why: hash-based colors produce arbitrary colors that may not contrast well and may repeat on subsequent agent spawns. Sequential assignment ensures the first 6 agents always get the same 6 distinctive colors.

**Color palette selection:** The 6 colors above (indigo, amber, emerald, red, violet, blue) are chosen to:

1. Be distinguishable on both light and dark backgrounds
2. Avoid the gray tones that DorkOS uses for UI chrome (so agents stand out)
3. Match the DorkOS brand palette (these are Tailwind 500-level colors from the existing theme)

---

## Pros/Cons Summary per Approach

### SVG Running Animation

| Approach                 | Pros                                                                                          | Cons                                                         | Verdict         |
| ------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------- |
| Pure CSS `@keyframes`    | GPU-composited, zero JS, no lib dependency, respects `prefers-reduced-motion` via media query | Slightly more SVG markup                                     | **RECOMMENDED** |
| Motion `useAnimate` loop | Familiar API, spring-adjustable                                                               | Overkill for infinite loop, JS overhead per frame            | Skip            |
| GSAP timeline            | Excellent control                                                                             | 34KB, not in codebase, overkill                              | Skip            |
| Lottie JSON              | Professional animations available                                                             | 50KB+ library, no dynamic coloring without JSON manipulation | Skip            |

### Slot-Width Animation

| Approach                                    | Pros                                                    | Cons                                                            | Verdict         |
| ------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------- | --------------- |
| `width: 0 → "auto"` with `overflow: hidden` | Clean, predictable, works with existing AnimatePresence | Must use two-div pattern                                        | **RECOMMENDED** |
| `layout` prop on siblings                   | Auto-reflows                                            | Complex with initial mount animation, fights width:0 start      | Skip            |
| `scale(0) → scale(1)`                       | GPU-composited                                          | Scales the content too (running figure shrinks), not slot-width | Skip            |
| CSS grid rows trick                         | Good for vertical                                       | Not applicable for horizontal slots                             | Skip            |

### Particle Burst

| Approach                   | Pros                                                  | Cons                                                                          | Verdict                             |
| -------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------- |
| `react-confetti-explosion` | 2KB, CSS-only, Portal-positioned, configurable colors | External dep                                                                  | **RECOMMENDED**                     |
| Hand-rolled CSS keyframes  | No deps                                               | 80+ lines boilerplate for particles                                           | Skip                                |
| `canvas-confetti`          | Excellent quality                                     | Canvas API, 28KB, needs cleanup                                               | Overkill for slot-level celebration |
| Motion particle animation  | In-codebase                                           | Motion doesn't natively do particles — hand-rolled Motion items still complex | Skip                                |

### Tooltip

| Approach                     | Pros                                                        | Cons                                               | Verdict         |
| ---------------------------- | ----------------------------------------------------------- | -------------------------------------------------- | --------------- |
| Radix `Tooltip` (existing)   | Already installed, Portal positioning, accessible, reactive | Requires `TooltipProvider` ancestor                | **RECOMMENDED** |
| CSS `::after` pseudo-element | Zero deps                                                   | Can't position above, no structured content        | Skip            |
| Custom motion div            | Full control                                                | ~40 lines for positioning + click-outside handling | Overkill        |

### Status Transition Detection

| Approach                        | Pros                               | Cons                                         | Verdict         |
| ------------------------------- | ---------------------------------- | -------------------------------------------- | --------------- |
| `useRef` in-render comparison   | Single-render, no extra re-renders | Mutates ref during render (unusual but safe) | **RECOMMENDED** |
| `useEffect` + `useState`        | Conventional React                 | 2-render cycle introduces delay              | Skip            |
| External state machine (XState) | Clean lifecycle                    | 15KB lib, overkill for a binary transition   | Skip            |

---

## Sources & Evidence

- [SVG Running CSS Animation — CodePen (web-tiki)](https://codepen.io/web-tiki/pen/gpWLbW) — `transform-origin: 50% 0` on leg groups for pivot-from-joint running animation, CSS `$cycle` variable for speed control
- [Animating SVG with CSS — LogRocket Blog](https://blog.logrocket.com/how-to-animate-svg-css-tutorial-examples/) — CSS `transform-origin` on SVG elements in HTML5 context, keyframe animation targeting SVG `<g>` groups
- [SVG Animation in React — Motion.dev](https://motion.dev/docs/react-svg-animation) — CSS custom property (`var(--token-xxx)`) pattern for dynamic SVG coloring; `will-change: transform` for compositing SVG animations
- [How to animate width and height with Framer Motion — joshuawootonn.com](https://www.joshuawootonn.com/how-to-animate-width-and-height-with-framer-motion) — Property-specific transition stagger: height leads, opacity follows with delay to prevent text clipping
- [Animated List — buildui.com](https://buildui.com/recipes/animated-list) — Exact `initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }} style={{ overflow: "hidden" }}` pattern; AnimatePresence `initial={false}` for history items
- [AnimatePresence — React exit animations — Motion.dev](https://motion.dev/docs/react-animate-presence) — `mode="popLayout"` pairs with `layout` prop for list reflow; `mode="sync"` (default) runs enter/exit simultaneously
- [Layout Animation — React FLIP & Shared Element — Motion.dev](https://motion.dev/docs/react-layout-animations) — `width: "auto"` is animatable in Motion; any layout change causes FLIP animation with `layout` prop
- [react-confetti-explosion — npm](https://www.npmjs.com/package/react-confetti-explosion) — CSS-only, portal-based, configurable `particleCount`, `colors`, `duration`; unmount after explosion finished
- [canvas-confetti — GitHub (catdad)](https://github.com/catdad/canvas-confetti) — Canvas-based, fire-and-forget API; 28KB; keep under 200 particles per burst for 60fps
- [mo.js Burst tutorial](https://mojs.github.io/tutorials/burst/) — Particle burst design reference: radial emit, staggered fade-out, angle spread
- [Tooltip — Radix UI Primitives](https://www.radix-ui.com/primitives/docs/components/tooltip) — `--radix-tooltip-content-transform-origin` for animation from computed origin; Portal rendering; collision detection via `data-side`/`data-align` attributes
- [usePrevious — useHooks.io](https://www.usehooks.io/docs/use-previous) — `useRef` + `useEffect` canonical pattern for previous value tracking
- [Implementing advanced usePrevious hook — developerway.com](https://www.developerway.com/posts/implementing-advanced-use-previous-hook) — In-render `useRef` mutation for synchronous detection (no `useEffect` delay)
- [How to change SVG color with CSS — nucleoapp.com](https://nucleoapp.com/blog/post/change-svg-color-css) — `currentColor` and CSS custom property approaches; inline `fill` attribute specificity overrides CSS
- [Fills and strokes — MDN](https://developer.mozilla.org/en-US/docs/Web/SVG/Tutorials/SVG_from_scratch/Fills_and_strokes) — `fill="var(--custom-property)"` supported in inline SVG in HTML5 documents
- Existing DorkOS research: `research/20260316_subagent_activity_streaming_ui_patterns.md` — SubagentPart data model, `status: 'running' | 'complete' | 'error'`, stream lifecycle events
- Existing DorkOS research: `research/20260320_chat_message_list_animations.md` — Motion spring presets, AnimatePresence patterns already used in codebase
- Existing DorkOS research: `research/20260309_chat_microinteractions_polish.md` — `MotionConfig reducedMotion="user"` already in App.tsx handles accessibility

---

## Research Gaps & Limitations

- **`transform-origin` on inline SVG in Safari 14 vs 15**: There was a known bug in Safari 14 where `transform-origin` on SVG elements did not respect percentage values. The workaround is to use absolute coordinates (e.g., `transform-origin: 8px 12px`) rather than `50% 100%`. The code examples above already use absolute coordinates to avoid this.
- **`react-confetti-explosion` exact bundle size**: Advertised as ~2KB but final gzipped size with its CSS was not directly measured. It remains the best CSS-only option regardless.
- **Simultaneous celebration timing**: If 3 agents complete in the same streaming flush, all 3 `justCompleted` entries will appear in the same render. The celebration `useEffect` runs once and adds all three to `celebratingSet` simultaneously. This is correct behavior but was not explicitly tested in DorkOS's environment.
- **`width: "auto"` animation in Motion with `overflow: hidden`**: The combination works in Motion 11+. If there are clipping artifacts during the expand animation, set `overflow: visible` during the animate phase and `overflow: hidden` only during exit — achievable with a `useMotionValue` or a simple state toggle.

---

## Contradictions & Disputes

- **`useRef` mutation during render**: Mutating `prevStatusRef.current` during the render phase (not in `useEffect`) is intentional and safe for `useRef` (refs are not part of React's state graph). However, it violates the conventional "no side effects in render" rule. If this feels wrong in code review, the `useEffect` alternative with a 1-render delay is acceptable — the visual delay is ~16ms (one frame), which is imperceptible for a celebration trigger.
- **Adding `messages` prop to `ChatInputContainer`**: An alternative is to read messages from Zustand directly inside `BackgroundAgentIndicatorBar` via a store selector. This avoids prop-drilling but couples the component to the store shape. Given that `ChatPanel` already passes many props down, adding one more is consistent with the existing pattern. Either approach is defensible.

---

## Search Methodology

- Searches performed: 12
- Most productive search terms: "motion.dev animate width 0 auto list slot", "SVG running figure CSS transform-origin keyframe", "react-confetti-explosion CSS animation", "usePrevious React useRef detect state transition", "Radix Tooltip CSS position above flex item"
- Primary sources: motion.dev official docs, buildui.com recipes (high quality production patterns), CodePen SVG animation examples, Radix UI primitives docs, npm package pages for confetti libs
- Leveraged 3 existing DorkOS research files that cover AnimatePresence patterns, subagent data model, and motion spring configs — no re-research needed for those areas
