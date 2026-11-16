---
slug: unified-status-strip
number: 153
created: 2026-03-20
status: ideation
---

# Unified Status Strip — Consolidate InferenceIndicator & SystemStatusZone

**Slug:** unified-status-strip
**Author:** Claude Code
**Date:** 2026-03-20
**Branch:** preflight/unified-status-strip

---

## 1) Intent & Assumptions

- **Task brief:** Consolidate `InferenceIndicator` and `SystemStatusZone` into a single `ChatStatusStrip` component that lives between the MessageList and chat input. Only one status type is visible at a time, with a defined priority stack. Visual styles converge on the cleaner, muted SystemStatusZone aesthetic while preserving the data richness of InferenceIndicator (rotating verbs, elapsed time, token count).

- **Assumptions:**
  - The strip replaces both existing components entirely (no parallel rendering)
  - Moving InferenceIndicator out of the scroll container (MessageList) is desirable — it becomes always-visible regardless of scroll position
  - The existing rotating verb system, elapsed time tracking, and token count display are worth preserving
  - The `useChatSession` hook's state shape does not change — only wiring at the ChatPanel level changes
  - The dev playground showcases (StatusShowcases.tsx) will be updated to reflect the new component

- **Out of scope:**
  - Changes to the `useChatSession` hook internals
  - New status types not already modeled (e.g., context window usage percentage)
  - StatusLine (bottom bar) consolidation — that's a separate component with different concerns
  - Changes to how system status messages are generated server-side

## 2) Pre-reading Log

- `apps/client/src/layers/features/chat/ui/InferenceIndicator.tsx`: 209-line component with 4 render states (streaming, complete, waiting-for-user, rate-limited). Uses `useElapsedTime` and `useRotatingVerb` hooks. Contains snapshot refs for post-stream summary. Positioned inside MessageList virtualizer.
- `apps/client/src/layers/features/chat/ui/SystemStatusZone.tsx`: 30-line minimal component. AnimatePresence with height+opacity animation. Info icon + message text. Auto-clears via useChatSession timer (4s).
- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx`: 423 lines. Destructures all streaming state from `useChatSession`. SystemStatusZone at line 353. InferenceIndicator props threaded through MessageList (lines 303-309).
- `apps/client/src/layers/features/chat/ui/MessageList.tsx`: 232 lines. InferenceIndicator rendered at lines 211-225 inside virtualizer, positioned absolutely below all virtual items. Receives 7 inference-related props.
- `apps/client/src/layers/features/chat/model/use-rotating-verb.ts`: 47 lines. Cycles through verb list avoiding consecutive repeats. Returns `{ verb, key }`.
- `apps/client/src/layers/shared/model/use-elapsed-time.ts`: 53 lines. Returns `{ formatted, ms }`, updates every 1s when active.
- `apps/client/src/layers/features/chat/ui/inference-themes.ts`: IndicatorTheme interface with icon, iconAnimation, verbs, verbInterval fields.
- `apps/client/src/layers/features/chat/ui/inference-verbs.ts`: 50 default verbs + 55 bypass-mode verbs.
- `apps/client/src/layers/features/chat/model/use-chat-session.ts`: State source. `systemStatus` auto-clears via 4s timeout. All streaming state managed here.
- `contributing/animations.md`: Motion library patterns — AnimatePresence, height animations, duration guidelines (100-300ms).
- `contributing/design-system.md`: Calm Tech design language — muted colors, subtle animations, data-dense but visually quiet.
- `specs/inference-status-indicator/02-specification.md` (spec 8): Original InferenceIndicator spec.
- `specs/system-status-compact-boundary/02-specification.md` (spec 136): SystemStatusZone spec — explicitly chose "outside the thread" placement.
- `research/20260316_system_status_compact_boundary_ui_patterns.md`: Prior research confirming system messages belong outside the scroll container.
- `research/20260310_statusline_compound_component_patterns.md`: Compound component architecture patterns — identifies limitations of React.Children introspection for priority-winner scenarios.

## 3) Codebase Map

- **Primary components/modules:**
  - `layers/features/chat/ui/InferenceIndicator.tsx` — Current streaming status display (to be replaced)
  - `layers/features/chat/ui/SystemStatusZone.tsx` — Current ephemeral status display (to be replaced)
  - `layers/features/chat/ui/ChatPanel.tsx` — Top-level chat orchestrator (wiring changes)
  - `layers/features/chat/ui/MessageList.tsx` — Virtualized message list (remove indicator and 7 props)

- **Shared dependencies:**
  - `layers/shared/model/use-elapsed-time.ts` — Elapsed time formatting hook (reused)
  - `layers/features/chat/model/use-rotating-verb.ts` — Verb rotation hook (reused)
  - `layers/features/chat/ui/inference-themes.ts` — Theme interface (reused)
  - `layers/features/chat/ui/inference-verbs.ts` — Verb lists (reused)
  - `motion/react` — AnimatePresence, motion.div (already a dependency)
  - `lucide-react` — Icons: Info, Shield, MessageSquare (already a dependency)

- **Data flow:**

  ```
  useChatSession → ChatPanel (destructures all state)
    ├── Currently: → MessageList → InferenceIndicator (7 props threaded through)
    ├── Currently: → SystemStatusZone (systemStatus prop)
    └── Target:    → ChatStatusStrip (all status props direct, no threading)
  ```

- **Feature flags/config:** None. The `permissionMode` prop determines bypass verb selection but isn't a feature flag.

- **Potential blast radius:**
  - Direct: 4 files modified (ChatPanel, MessageList, new ChatStatusStrip, new useStripState hook)
  - Deleted: 2 files (InferenceIndicator.tsx, SystemStatusZone.tsx)
  - Tests: 3 test files need updates (InferenceIndicator.test.tsx, SystemStatusZone.test.tsx → new ChatStatusStrip.test.tsx; MessageList.test.tsx)
  - Dev playground: StatusShowcases.tsx needs update

## 4) Root Cause Analysis

N/A — this is a feature consolidation, not a bug fix.

## 5) Research

Full research report: `research/20260320_unified_status_strip.md`

### Potential Solutions

**1. Simple Switcher — Conditional rendering with if/else priority chain**

- Pros: Simplest implementation, no abstractions, trivial to read
- Cons: Priority logic implicit in if/else ordering, easy to accidentally reorder, high cyclomatic complexity approaching project limit
- Complexity: Low | Maintenance: Low-Medium

**2. Priority Queue — Message queue with priority levels**

- Pros: Explicit priority, TTL-based auto-dismiss, extensible to many status sources
- Cons: Significantly over-engineered for 5 well-defined states, requires queue state manager
- Complexity: High | Maintenance: Medium

**3. State Machine with Prioritized Content Slots (Recommended)**

- Pros: Explicit priority via `deriveStripState()` pure function, testable without React mocks, TypeScript exhaustiveness via discriminated union, matches existing codebase patterns (StatusLine), `AnimatePresence mode="wait"` uses `state.type` as key for clean crossfades
- Cons: More upfront code than simple switcher, `showComplete` snapshot refs must be maintained in a hook
- Complexity: Low-Medium | Maintenance: Very Low

**4. Compound Component with Pluggable Slots**

- Pros: Declarative JSX, plugin-friendly
- Cons: All slots' hooks run regardless of visibility (performance), React.Children introspection problematic (per prior research), compound pattern solves multi-winner scenarios but this is single-winner
- Complexity: High | Maintenance: Medium-High

### Industry Comparisons

- **Claude.ai**: Pulsing dot, no metrics, status disappears on completion
- **ChatGPT**: Shimmer ellipsis, no elapsed time for standard models
- **Cursor/Windsurf**: Thin spinner in input chrome, minimal
- **VS Code Status Bar**: Dual-zone, constraint-driven — each item earns its space
- **Slack**: Fixed typing indicator zone between thread and input (canonical source of SystemStatusZone pattern)
- **Apple Dynamic Island**: Single morphing container that transitions between contexts — the design principle behind the state machine approach

### Recommendation

**Approach 3: State Machine with Prioritized Content Slots.** A `deriveStripState()` pure function maps raw props to a `StripState` discriminated union. The component renders the correct content via `AnimatePresence mode="wait"` crossfade keyed by `state.type`. Two-layer animation: outer height collapse/expand + inner content crossfade.

## 6) Decisions

| #   | Decision                                             | Choice                         | Rationale                                                                                                                                                                                               |
| --- | ---------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Priority when rate-limited/waiting vs system message | Action states win              | Rate-limited and waiting-for-user require user action to continue. System messages are informational and can wait. Priority: rate-limited > waiting > system-message > streaming > complete.            |
| 2   | Post-stream completion summary behavior              | Auto-dismiss after 8 seconds   | Long enough to read the summary, short enough to clear the strip. Matches the ephemeral feel of SystemStatusZone and prevents the strip from occupying space indefinitely.                              |
| 3   | Style convergence depth                              | Keep data, adopt color palette | Preserve rotating verbs, elapsed time, and token count — Kai wants this data. Render in the muted SystemStatusZone palette (text-muted-foreground/60, text-xs). Information stays; visual weight drops. |

### Additional Design Decisions (from research)

| #   | Decision                        | Choice                                                                                           | Rationale                                                                                                                                                               |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4   | Placement                       | Between MessageList and input (outside scroll container)                                         | Always visible regardless of scroll position. Matches SystemStatusZone's current position. Users build mental model: "that zone tells me what the agent is doing."      |
| 5   | Architecture                    | State Machine (Approach 3)                                                                       | Explicit priority, testable pure function, TypeScript-exhaustive, matches codebase patterns. Dynamic Island principle: one element, different content, smooth morphing. |
| 6   | Animation stack                 | Outer height collapse (200ms) + inner crossfade mode="wait" (150ms) + verb sub-animation (300ms) | Three-layer animation provides smooth transitions at every level. Matches StatusLine.tsx pattern.                                                                       |
| 7   | System message contextual icons | Implement as optional delight                                                                    | Pattern system message content → icon: "compact" → RefreshCw, "permission" → Shield, default → Info. Small but thoughtful.                                              |
| 8   | Complete state auto-dismiss     | 8-second timer via useEffect                                                                     | Non-intrusive duration. Mirrors the ephemeral pattern of system messages.                                                                                               |

### Priority Stack (encoded in `deriveStripState`)

```
1. rate-limited       → user needs to know they're waiting
2. waiting-for-user   → user action required to continue
3. system-message     → SDK operational event (informational)
4. streaming          → normal inference in progress (ambient)
5. complete           → post-stream summary (lowest, auto-dismisses)
6. idle               → nothing to show
```

### Visual Specification

```
STREAMING:    ✨ Analyzing...           0:12  ~4.2k tokens   (muted palette)
WAITING:      🛡 Waiting for approval   0:23                  (amber palette)
RATE-LIMITED: ⏳ Retrying in 12s        0:45                  (amber palette)
SYSTEM:       ℹ Compacting context...                         (muted palette)
COMPLETE:     0:32 · ~12.3k tokens                            (60% opacity, auto-dismiss)
```

All states: `text-xs`, `py-2`, centered, `overflow-hidden` container. Alert states use amber. Everything else uses `text-muted-foreground/60`.

### Files to Create/Modify/Delete

| Action | File                                                          | Description                                                |
| ------ | ------------------------------------------------------------- | ---------------------------------------------------------- |
| Create | `layers/features/chat/ui/ChatStatusStrip.tsx`                 | Unified component + `deriveStripState` + `StripState` type |
| Create | `layers/features/chat/model/use-strip-state.ts`               | Hook: snapshot refs, countdown, showComplete timer         |
| Create | `layers/features/chat/__tests__/ChatStatusStrip.test.tsx`     | Tests for all states + priority logic + transitions        |
| Modify | `layers/features/chat/ui/ChatPanel.tsx`                       | Wire ChatStatusStrip, remove SystemStatusZone              |
| Modify | `layers/features/chat/ui/MessageList.tsx`                     | Remove InferenceIndicator + 7 props                        |
| Modify | `dev/showcases/StatusShowcases.tsx`                           | Update playground for new component                        |
| Delete | `layers/features/chat/ui/InferenceIndicator.tsx`              | Replaced by ChatStatusStrip                                |
| Delete | `layers/features/chat/ui/SystemStatusZone.tsx`                | Replaced by ChatStatusStrip                                |
| Delete | `layers/features/chat/__tests__/InferenceIndicator.test.tsx`  | Replaced by ChatStatusStrip.test.tsx                       |
| Delete | `layers/features/chat/ui/__tests__/SystemStatusZone.test.tsx` | Replaced by ChatStatusStrip.test.tsx                       |
| Keep   | `layers/features/chat/ui/inference-themes.ts`                 | Reused by ChatStatusStrip                                  |
| Keep   | `layers/features/chat/ui/inference-verbs.ts`                  | Reused by ChatStatusStrip                                  |
| Keep   | `layers/features/chat/model/use-rotating-verb.ts`             | Reused by ChatStatusStrip                                  |
| Keep   | `layers/shared/model/use-elapsed-time.ts`                     | Reused by ChatStatusStrip                                  |
