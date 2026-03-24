---
slug: background-agent-indicator
number: 173
created: 2026-03-23
status: ideation
---

# Background Agent Indicator

**Slug:** background-agent-indicator
**Author:** Claude Code
**Date:** 2026-03-23
**Branch:** preflight/background-agent-indicator

---

## 1) Intent & Assumptions

- **Task brief:** Build a persistent animated indicator in ChatInputContainer that shows running background agents (subagents) as tiny animated running figures. Each agent gets a unique color, hover tooltips showing agent details (description, tool count, duration, last tool), and a per-agent completion celebration (particle burst → checkmark → slot collapse) when it finishes. The indicator bar appears when the first agent spawns and disappears when the last one completes.

- **Assumptions:**
  - All data comes from existing `SubagentPart` entries streamed via SSE — no server or schema changes needed
  - The design is locked in from mockup iterations: V3D Compact (22x24px), slot-unfold transitions, particle burst celebrations
  - The indicator sits between ChatInput and ChatStatusSection in ChatInputContainer
  - Maximum 5 agent colors in the palette (blue, green, purple, amber, rose)
  - The feature works in both standalone web and Obsidian embedded modes

- **Out of scope:**
  - Changes to the existing SubagentBlock inline rendering in messages
  - Server-side SDK changes or new SubagentPart schema fields
  - Click-to-scroll-to-subagent behavior (could be a follow-up)
  - Task/TodoList integration (separate system from subagents)

## 2) Pre-reading Log

- `apps/client/src/layers/features/chat/ui/ChatInputContainer.tsx`: 320-line container component. Renders ScanLine, drag-drop overlay, interactive mode (ToolApproval/QuestionPrompt), and normal mode (palettes, FileChipBar, QueuePanel, ChatInput, ChatStatusSection). The indicator slots between ChatInput and ChatStatusSection.
- `apps/client/src/layers/features/chat/ui/SubagentBlock.tsx`: 69-line component using CollapsibleCard primitive. Renders subagent lifecycle inline in messages with status icon, description, tool summary, and expandable detail.
- `apps/client/src/layers/features/chat/model/stream-tool-handlers.ts`: Contains `handleSubagentStarted`, `handleSubagentProgress`, `handleSubagentDone` — mutates SubagentPart entries in currentPartsRef during streaming.
- `apps/client/src/layers/features/chat/model/chat-types.ts`: Defines ChatMessage with `parts: MessagePart[]` where MessagePart includes SubagentPart.
- `apps/client/src/layers/features/chat/model/use-chat-session.ts`: Orchestrates chat session, accumulates messages, handles SSE stream. Messages are stored in state and contain all parts including SubagentParts.
- `apps/client/src/layers/shared/ui/ScanLine.tsx`: 109-line three-layer composited animation — ambient glow, scanner beam, energy highlight. Uses CSS custom property for agent color. Good reference for animation architecture in the project.
- `packages/shared/src/schemas.ts` (lines 548-566): `SubagentPartSchema` defines: `type`, `taskId`, `description`, `status` (running/complete/error), `toolUses?`, `lastToolName?`, `durationMs?`, `summary?`.
- `apps/client/src/layers/shared/model/app-store.ts`: Zustand store. Has `autoHideToolCalls` toggle. No existing subagent-specific state.
- `apps/client/src/layers/features/chat/ui/primitives/`: Contains `CollapsibleCard`, `ToolStatusIcon` and related shared primitives for tool/subagent rendering.
- `contributing/animations.md`: Documents motion library patterns — `AnimatePresence` for enter/exit, spring configs, stagger patterns. Key: use `mode="popLayout"` or `mode="sync"` for list animations.
- `contributing/design-system.md`: Calm Tech philosophy. Anti-patterns include dramatic animations (bounces, spins, elastic effects) — but ScanLine already uses sophisticated multi-layer animation, so expressive animation for functional purposes is acceptable.
- `contributing/state-management.md`: TanStack Query for server state, Zustand for UI state. Derived state should use useMemo over existing data rather than duplicating into stores.

## 3) Codebase Map

**Primary Components/Modules:**

- `apps/client/src/layers/features/chat/ui/ChatInputContainer.tsx` — Mount point for the indicator (between ChatInput and ChatStatusSection)
- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx` — Parent that owns messages state, passes it to ChatInputContainer
- `apps/client/src/layers/features/chat/ui/SubagentBlock.tsx` — Existing inline subagent rendering (reference for data shape)
- `apps/client/src/layers/features/chat/model/stream-tool-handlers.ts` — Updates SubagentPart statuses during streaming
- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — Owns messages array with SubagentParts

**Shared Dependencies:**

- `motion/react` — AnimatePresence, motion.div for enter/exit transitions
- `@dorkos/shared/types` — SubagentPart type
- `apps/client/src/layers/shared/ui/` — Tooltip component (if available), cn utility
- `apps/client/src/layers/shared/lib/` — cn, TIMING constants

**Data Flow:**

```
SDK subagent events → server sdk-event-mapper → SSE stream →
  client stream-tool-handlers (mutates SubagentPart in message.parts) →
    messages state update → ChatPanel re-render →
      ChatInputContainer receives messages prop →
        useRunningSubagents(messages) derives running list →
          RunningAgentIndicator renders AgentRunner[] with tooltips
```

**Feature Flags/Config:**

- None needed initially. Could add `showRunningAgentIndicator` to useAppStore later if users want to toggle it.

**Potential Blast Radius:**

- **New files (4):**
  - `features/chat/ui/RunningAgentIndicator.tsx` — indicator bar component
  - `features/chat/ui/AgentRunner.tsx` — animated SVG running figure
  - `features/chat/ui/AgentRunnerBurst.tsx` — particle burst celebration
  - `features/chat/model/use-running-subagents.ts` — hook to derive running subagents from messages
- **Modified files (2):**
  - `features/chat/ui/ChatInputContainer.tsx` — add indicator between ChatInput and ChatStatusSection
  - `features/chat/index.ts` — export new components (if needed for barrel)
- **Test files (2):**
  - `features/chat/model/__tests__/use-running-subagents.test.ts` — hook unit tests
  - `features/chat/ui/__tests__/RunningAgentIndicator.test.tsx` — component render tests

## 4) Root Cause Analysis

N/A — this is a new feature, not a bug fix.

## 5) Research

**Potential Solutions:**

**1. CSS Keyframe SVG Animation (Selected in mockups)**

- Description: SVG running figure with CSS `@keyframes` for joint rotation, body bounce. Each limb segment rotates from its joint origin. CSS custom property `--c` sets the agent color.
- Pros:
  - Zero JS overhead for animation — GPU-composited CSS transforms
  - Already proven in mockups across 5 variations
  - Simple to implement — just CSS classes on SVG groups
  - Multiple simultaneous runners have negligible performance cost
- Cons:
  - Less flexible than Motion for dynamic values
  - Can't easily change animation speed at runtime
- Complexity: Low
- Maintenance: Low

**2. Motion-driven SVG Animation**

- Description: Use `motion.g` and `motion.line` for all limb animations with Motion's spring physics.
- Pros:
  - Smoother easing, physics-based feel
  - Can dynamically adjust animation parameters
- Cons:
  - Higher JS overhead per frame per runner (5 runners × 10+ animated elements = 50+ Motion instances)
  - Overkill for a looping run cycle that doesn't need dynamic values
  - More complex component code
- Complexity: High
- Maintenance: Medium

**3. Lottie/Rive Animation**

- Description: Design the runner in After Effects or Rive, export as Lottie JSON or .riv, render with react-lottie or @rive-app/react.
- Pros:
  - Highest visual quality, designer-friendly workflow
  - Efficient playback engine
- Cons:
  - Adds a dependency (lottie-react or @rive-app/react)
  - Harder to dynamically color per-agent
  - Asset management overhead
  - Overkill for a 22px icon
- Complexity: Medium
- Maintenance: High

**Recommendation:** CSS Keyframe SVG Animation. Already proven in mockups, zero runtime overhead, trivially colorable via CSS custom properties. The V3D compact runner with 0.36s cycle, jointed limbs, and body bounce is the final design.

**Transition Approach:**

- Slot-unfold pattern for enter/exit (animate slot width 0→22px, figure scales in)
- `AnimatePresence` from Motion for orchestrating the enter/exit lifecycle
- Completion celebration: CSS particle burst → CSS checkmark scale-in → Motion AnimatePresence exit

**Tooltip Approach:**

- CSS-only hover tooltip (position: absolute, opacity transition)
- No Radix Tooltip dependency needed — the indicator is a simple hover target
- Content updates reactively from SubagentPart fields

## 6) Decisions

| #   | Decision                       | Choice                                          | Rationale                                                                                                                                                           |
| --- | ------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | FSD layer placement            | `features/chat/ui/`                             | Co-located with ChatInputContainer, SubagentBlock, and stream handlers. Chat-specific, not reusable elsewhere.                                                      |
| 2   | State model for running agents | Scan all message parts (useMemo)                | Derives from existing data — no state duplication. Automatically correct when stream handlers update statuses. Follows `contributing/state-management.md` guidance. |
| 3   | Completion celebration trigger | Track previous status with useRef per-component | Each AgentRunner tracks its own status transitions. Self-contained — no parent coordination needed.                                                                 |
| 4   | Overflow handling (5+ agents)  | Show 4 runners + overflow count badge           | Keeps indicator compact. Overflow badge has tooltip listing extra agents. Covers the edge case without visual noise.                                                |
