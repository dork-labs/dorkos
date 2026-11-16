---
slug: chat-streaming-motion
number: 152
created: 2026-03-20
status: ideation
---

# Chat Streaming Motion — Premium Text & Scroll Animation

**Slug:** chat-streaming-motion
**Author:** Claude Code
**Date:** 2026-03-20

---

## 1) Intent & Assumptions

- **Task brief:** Make the chat streaming experience feel smoother and more premium. Currently, streamed text chunks appear abruptly and the message list jumps as new content arrives. We want per-word text animation effects (fade, blur-in, slide-up), spring-based smooth scrolling during streaming, and the ability to preview and toggle these effects in the dev simulator.
- **Assumptions:**
  - `streamdown` (already installed) has a built-in `animated` prop with `fadeIn`, `blurIn`, `slideUp` presets that wraps text nodes in animated spans post-markdown-rendering
  - The `motion` library (already installed) handles message entry animations — those are already solid and not the focus here
  - `use-stick-to-bottom` (StackBlitz Labs) is the de-facto standard for spring-based streaming scroll, used by shadcn/ui AI Conversation and prompt-kit
  - Performance is non-negotiable — only GPU-composited properties (`opacity`, `transform`, `filter`) may be animated
  - `prefers-reduced-motion` must be respected — falls back to no animation
  - The dev simulator must be able to toggle effects on/off for visual QA
- **Out of scope:**
  - Message entry animations (already implemented with spring physics in `MessageItem.tsx`)
  - Tool call card animations (already implemented with AnimatePresence)
  - Server-side token smoothing (Vercel AI SDK `smoothStream` pattern — different architecture)
  - Character-level animation (too many spans — word-level is the safe limit)
  - Virtualization changes (TanStack Virtual setup stays as-is)

---

## 2) Pre-reading Log

### Chat Streaming & Scroll

- `apps/client/src/layers/features/chat/ui/StreamingText.tsx` (96 lines): Wraps `Streamdown` with link safety modal. Currently passes no `animated` prop — text chunks appear instantly. Adds `.streaming-cursor` CSS class when streaming.
- `apps/client/src/layers/features/chat/ui/MessageList.tsx` (329 lines): TanStack Virtual with `estimateSize: 80`, `overscan: 5`. Three scroll-to-bottom fallbacks: ResizeObserver (primary), message-count-change effect (secondary), IntersectionObserver (Obsidian visibility). Auto-scroll sets `scrollTop = scrollHeight - clientHeight` directly — no spring interpolation. User intent detection via wheel/touch events with 150ms debounce.
- `apps/client/src/layers/features/chat/ui/message/MessageItem.tsx`: Spring entry animation with `stiffness: 320, damping: 28`, `isNew` gate prevents history items from animating.
- `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx`: Maps message parts to `StreamingText` — only last text part shows streaming cursor.
- `apps/client/src/index.css` (lines 365-410): `.streaming-cursor` uses `::after` pseudo-element chain with blink animation. Design tokens: `--msg-enter-y: 8px`, `--msg-enter-stiffness: 320`, etc.

### Dev Simulator

- `apps/client/src/dev/simulator/use-simulator.ts` (336 lines): `useReducer` state machine with `stream_text_chunk` step type. Tick engine with `setTimeout` and speed multiplier. Exposes `play/pause/step/reset/seekTo`.
- `apps/client/src/dev/simulator/SimulatorControls.tsx` (142 lines): Scenario picker, transport buttons, speed presets (0.25x-4x), timeline slider, phase badge.
- `apps/client/src/dev/simulator/SimulatorChatPanel.tsx` (50 lines): Wraps real `MessageList` with simulator state. Read-only input placeholder.
- `apps/client/src/dev/simulator/sim-helpers.ts`: `buildStreamingTextSteps()` splits text at word boundaries, ~4 words per chunk, 100ms delay.

### Shared Constants

- `apps/client/src/layers/shared/lib/constants.ts`: `TIMING` object with motion-related constants.

### Research Artifacts

- `research/20260320_chat_message_list_animations.md`: Comprehensive research on list animations, `use-stick-to-bottom`, FLIP technique, virtual list constraints.
- `research/20260320_llm_streaming_text_animation_techniques.md`: Streamdown `animated` prop discovery, CSS technique catalog, performance rules, swappable effect architecture.

---

## 3) Codebase Map

**Primary Components (will be modified):**

- `apps/client/src/layers/features/chat/ui/StreamingText.tsx` — Add `animated` prop to Streamdown, accept effect config
- `apps/client/src/layers/features/chat/ui/MessageList.tsx` — Add `overflow-anchor: none`, evaluate `use-stick-to-bottom` integration
- `apps/client/src/dev/simulator/SimulatorControls.tsx` — Add effect toggle controls
- `apps/client/src/dev/simulator/SimulatorChatPanel.tsx` — Pass effect config to MessageList/StreamingText
- `apps/client/src/dev/pages/SimulatorPage.tsx` — Manage effect toggle state

**New Files:**

- `apps/client/src/layers/shared/lib/text-effects.ts` — `TextEffectMode` type, `TextEffectConfig` interface, `useTextEffectConfig()` hook, streamdown config resolver

**Shared Dependencies:**

- `streamdown` (v2.4.0, already installed) — `animated` prop with `blurIn`, `fadeIn`, `slideUp` presets
- `use-stick-to-bottom` (new dependency) — Spring-based scroll for streaming
- `motion/react` (already installed) — Existing message entry animations, unaffected
- `@tanstack/react-virtual` (already installed) — Virtualization, unaffected

**Data Flow:**

```
TextEffectConfig (state/context)
  → StreamingText → Streamdown animated prop → per-word <span class="sd-flow-token"> → CSS animation
  → MessageList → use-stick-to-bottom → spring-interpolated scrollTop

Simulator:
  SimulatorPage (effect toggle state)
    → SimulatorControls (toggle UI)
    → SimulatorChatPanel → MessageList → StreamingText (with effect config)
```

**Potential Blast Radius:**

- Direct: 6 files (StreamingText, MessageList, SimulatorControls, SimulatorChatPanel, SimulatorPage, new text-effects.ts)
- Indirect: `streamdown` CSS import may be needed (`streamdown/styles.css`)
- Tests: `StreamingText` mock in MessageList tests may need updating if props change
- No server changes. No shared package changes.

---

## 4) Root Cause Analysis

N/A — this is a feature/polish task.

The current experience feels abrupt because:

1. **Text chunks append to the DOM with no visual transition** — Streamdown renders markdown but the `animated` prop is not used
2. **Auto-scroll is instant** (`scrollTop = scrollHeight - clientHeight`) — no spring interpolation between positions
3. **No `overflow-anchor: none`** on the scroll container — browser's native scroll anchoring fights with programmatic scroll during streaming

---

## 5) Research

### Potential Solutions

**1. Streamdown `animated` prop + `overflow-anchor: none` (Recommended)**

- Description: Enable streamdown's built-in per-word animation on `StreamingText`, add `overflow-anchor: none` to the message list scroll container, and add effect toggle controls to the simulator.
- Pros:
  - Zero new dependencies for text animation (streamdown already installed)
  - Per-word animation works post-markdown-rendering (code blocks, links, etc. are preserved)
  - Spans are excluded when `isAnimating={false}` (no residual DOM overhead on completed messages)
  - Three built-in presets (`blurIn`, `fadeIn`, `slideUp`) cover the desired effect range
  - `overflow-anchor: none` is a one-line CSS fix for scroll jumps
- Cons:
  - Need to verify streamdown v2.4.0 actually has the `animated` prop (check docs/changelog)
  - Word-level splitting adds ~180 spans per 1000 chars during streaming (acceptable, but worth monitoring)
- Complexity: Low
- Maintenance: Low

**2. Streamdown `animated` + `use-stick-to-bottom` for spring scroll**

- Description: Everything in option 1, plus replace the custom scroll logic in `MessageList.tsx` with `use-stick-to-bottom` for spring-interpolated auto-scroll.
- Pros:
  - Spring-based scroll creates a visibly smoother streaming experience
  - Battle-tested library (shadcn/ui AI Conversation, prompt-kit)
  - Built-in detach/reattach with proper user-intent detection
  - Reduces custom scroll code in MessageList
- Cons:
  - New dependency (~3KB)
  - Current scroll logic is sophisticated (three fallbacks, Obsidian visibility detection) — migration requires care
  - `use-stick-to-bottom` may not handle the Obsidian IntersectionObserver case
  - Integration with TanStack Virtual's absolute positioning needs testing
- Complexity: Medium
- Maintenance: Low

**3. Custom per-word animation (no streamdown)**

- Description: Build a custom rehype/remark plugin or post-processing step that wraps text nodes in animated spans, independent of streamdown.
- Pros:
  - Full control over animation behavior
  - Not coupled to streamdown's implementation
- Cons:
  - Reinventing what streamdown already provides
  - Must handle markdown AST walking, code block exclusion, streaming state management
  - Significantly more code to write and maintain
- Complexity: High
- Maintenance: High

**4. FlowToken library**

- Description: Use the `flowtoken` library's `AnimatedMarkdown` component instead of/alongside streamdown.
- Pros:
  - Purpose-built for LLM streaming animation
  - Word-level animation with multiple presets
- Cons:
  - New dependency that duplicates streamdown's markdown rendering
  - Would require replacing or wrapping Streamdown — high integration risk
  - Less battle-tested than streamdown
- Complexity: Medium-High
- Maintenance: Medium

### Performance Considerations

- **Safe animated properties:** `opacity` and `transform` are GPU-composited, never trigger layout. `filter: blur()` is acceptable for one-shot mount animations (< 8px blur radius).
- **Span count:** Word-level splitting produces ~180 spans per 1000 chars — well within safe bounds. Character-level (~1000 spans) is risky on mobile. Always use `sep: 'word'`.
- **Completed messages:** Streamdown excludes animation spans when `isAnimating={false}`. Critical — without this, scrolling through history would create thousands of unnecessary DOM nodes.
- **`will-change`:** Never apply to individual word spans. Only on the containing message wrapper if needed.
- **`overflow-anchor: none`:** Prevents browser's native scroll anchoring from conflicting with programmatic scroll. No performance cost.

### Recommendation

**Start with Option 1** (streamdown `animated` + `overflow-anchor: none`). This delivers the highest impact for the lowest effort — the text streaming transformation alone will make the experience feel dramatically more premium. Add simulator effect toggles for visual QA.

**Option 2** (`use-stick-to-bottom`) is a strong follow-up but involves more migration risk. It should be a separate PR after the text animation is validated, since the current scroll logic is battle-tested and the `overflow-anchor: none` fix addresses the worst scroll jumps immediately.

---

## 6) Decisions

| #   | Decision                              | Choice                                    | Rationale                                                                                                            |
| --- | ------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | Text animation approach               | Streamdown `animated` prop                | Already installed, zero new deps, handles markdown AST correctly, auto-disables on completed messages                |
| 2   | Default text effect                   | `blurIn`                                  | Perplexity-style blur-in is the most premium feel; only major AI chat app doing per-word animation                   |
| 3   | Animation granularity                 | Word-level (`sep: 'word'`)                | ~180 spans/1000 chars is safe. Character-level (~1000 spans) risks mobile perf                                       |
| 4   | Scroll jump fix                       | `overflow-anchor: none` CSS               | One-line fix, no dependency, addresses browser scroll anchoring conflicts                                            |
| 5   | Spring scroll (`use-stick-to-bottom`) | Defer to follow-up PR                     | Current scroll logic is sophisticated; migration needs careful testing. `overflow-anchor` fixes the worst issue now. |
| 6   | Effect config architecture            | `TextEffectMode` union type + config hook | Simple, extensible, respects `prefers-reduced-motion`, maps cleanly to streamdown's `animated` config                |
| 7   | Simulator integration                 | Toggle controls in SimulatorControls      | Dropdown for effect mode + toggle for animation on/off. Allows visual comparison of all effects.                     |
| 8   | Reduced motion                        | Auto-disable via `prefers-reduced-motion` | Accessibility requirement. `useTextEffectConfig()` hook returns `mode: 'none'` when reduced motion is preferred.     |

---

## 7) Proposed Changes

### Phase 1: Text Effect System (core)

**P1.1 — Text effect config** (new file: `layers/shared/lib/text-effects.ts`)

- `TextEffectMode` type: `'none' | 'fade' | 'blur-in' | 'slide-up'`
- `TextEffectConfig` interface: `{ mode, duration?, easing?, sep? }`
- `useTextEffectConfig(preferred)` hook: resolves active mode, respects `prefers-reduced-motion`
- `resolveStreamdownAnimation(config)`: maps `TextEffectConfig` to streamdown's `animated` prop format
- Default config constant: `DEFAULT_TEXT_EFFECT: TextEffectConfig = { mode: 'blur-in', duration: 150, easing: 'ease-out', sep: 'word' }`

**P1.2 — Enable streamdown animation** (`StreamingText.tsx`)

- Import `resolveStreamdownAnimation` and accept optional `textEffect` prop
- Pass `animated={resolveStreamdownAnimation(config)}` and `isAnimating={isStreaming}` to `Streamdown`
- Import `streamdown/styles.css` if required for animation styles
- Maintain existing `.streaming-cursor` behavior

**P1.3 — Scroll jump fix** (`MessageList.tsx`)

- Add `overflow-anchor: none` to the scroll container (`chat-scroll-area` or inline style)

### Phase 2: Simulator Effect Toggles

**P2.1 — Effect toggle state** (`SimulatorPage.tsx`)

- Add `textEffectMode` state with `TextEffectMode` type, default `'blur-in'`
- Add `animationEnabled` boolean toggle, default `true`
- Pass config down to `SimulatorControls` and `SimulatorChatPanel`

**P2.2 — Toggle controls** (`SimulatorControls.tsx`)

- Add effect mode selector (dropdown: none / fade / blur-in / slide-up)
- Add animation on/off toggle switch
- Place in the controls bar alongside speed selector

**P2.3 — Wire through to chat panel** (`SimulatorChatPanel.tsx`)

- Accept `textEffect` config prop
- Pass to `MessageList` which passes to `StreamingText` (or use React context if prop drilling becomes unwieldy)

### Phase 3: Polish & Validation

**P3.1 — Visual QA with simulator**

- Run each scenario with each effect mode
- Verify code blocks, links, and inline code are not broken by animation spans
- Verify completed messages have no residual animation DOM
- Verify `prefers-reduced-motion` disables all effects

**P3.2 — Performance validation**

- Profile with React DevTools during extended-conversation scenario
- Verify DOM node count stays reasonable during long streaming sessions
- Check that animation cleanup happens when messages complete

---

## 8) Clarification

1. **Streamdown version:** Need to verify that the installed version of `streamdown` actually supports the `animated` prop. The research indicates v2.4.0+ has it, but we should check `package.json` / `pnpm-lock.yaml` and the actual module exports before implementation.

2. **Effect default for production:** Should the text animation be enabled by default in production, or should it start as a dev-only feature? Recommendation: enabled by default with `blur-in`, since it degrades gracefully (reduced motion users see instant text, and the performance profile is safe at word-level).

3. **User settings:** Should the text effect mode be exposed in Settings for end users to choose, or is this purely a dev/design decision? If exposed, it would go in the config system alongside font settings.

4. **`use-stick-to-bottom` timing:** When should the spring-scroll migration happen? The recommendation is a separate follow-up PR, but it could be bundled if scope allows.
