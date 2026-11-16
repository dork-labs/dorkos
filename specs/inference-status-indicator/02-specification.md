---
slug: inference-status-indicator
---

# Inference Status Indicator — Specification

**Status:** Ready for Implementation
**Author:** Claude Code
**Date:** 2026-02-12
**Slug:** inference-status-indicator
**Ideation:** `specs/inference-status-indicator/01-ideation.md`

---

## Overview

Add a web-native inference status indicator to the chat UI that appears below the last message during streaming. The indicator shows an animated shimmer asterisk, rotating witty verbs with smooth crossfade transitions, elapsed time, and estimated token count. On completion, it collapses in-place to a compact summary line with no layout shift.

### Visual States

**Streaming:**

```
* Droppin' Science    2m 14s    ~3.2k tokens
```

- Asterisk pulses with shimmer animation (2s loop)
- Verb crossfades to a new random phrase every 3.5s
- Elapsed time updates every second
- Token estimate grows as text arrives

**Complete:**

```
2m 14s · ~3.2k tokens
```

- Compact, muted summary — same vertical space, no layout shift
- Persists as a subtle timestamp on the turn

## Non-Goals

- User-selectable themes UI (theme system is pluggable but not exposed)
- Holiday auto-detection
- Server-side timing/token counting changes
- Progress bars or completion estimation
- Persisting summary data across sessions

---

## Technical Design

### Architecture

The indicator integrates into the existing streaming pipeline without architectural changes:

```
SSE stream → useChatSession (tracks timing/tokens) → ChatPanel → MessageList → InferenceIndicator
```

- **State lives in `useChatSession`** — single source of truth for streaming timing and token estimation
- **Timing/estimation is lightweight** — refs + simple arithmetic, no external services
- **Rendering is declarative** — two visual states (streaming vs complete), driven by `status` prop
- **Theme system is data-driven** — plain objects define icon, animation, verbs, and styling

### Data Flow

```
useChatSession
  ├─ streamStartTime (ref, set on first text_delta)
  ├─ estimatedTokens (ref, chars/4 from text_deltas)
  └─ status ('streaming' | 'idle')
       │
       ↓
  ChatPanel (destructures new values)
       │
       ↓
  MessageList (passes as props)
       │
       ↓
  InferenceIndicator
    ├─ useElapsedTime(startTime) → "2m 14s"
    ├─ useRotatingVerb(verbs, 3500) → { verb, key }
    └─ AnimatePresence (verb crossfade)
```

### IndicatorTheme Interface

```typescript
export interface IndicatorTheme {
  name: string;
  icon: string; // e.g. "*", "✦", "❄"
  iconAnimation: string | null; // CSS @keyframes name, or null for static
  verbs: readonly string[];
  verbInterval: number; // ms between rotations (default: 3500)
  completionVerb?: string; // optional verb for complete state
}
```

### Token Estimation

No per-turn output token counts from the server. Client-side heuristic:

```typescript
// In handleStreamEvent('text_delta'):
estimatedTokensRef.current += text.length / 4; // ~1 token ≈ 4 chars
```

Displayed as `~1.2k tokens` (>= 1000) or `~450 tokens` (< 1000).

---

## File-by-File Implementation

### New Files

#### 1. `apps/client/src/components/chat/inference-verbs.ts`

50 custom verb phrases — mix of 70s Black slang / jive talk and 90s hip-hop slang. NOT reusing Claude Code CLI verbs. Mix of single verbs and short phrases.

Examples: "Keepin' It Real", "Droppin' Science", "Gettin' Jiggy", "Can You Dig It?", "Word to Your Mother", etc.

Exported as `const DEFAULT_INFERENCE_VERBS = [...] as const`.

#### 2. `apps/client/src/components/chat/inference-themes.ts`

Theme interface + `DEFAULT_THEME` definition:

- `icon: '*'`
- `iconAnimation: 'shimmer-pulse'`
- `verbs: DEFAULT_INFERENCE_VERBS`
- `verbInterval: 3500`

Includes commented-out example of a holiday theme for documentation.

#### 3. `apps/client/src/hooks/use-elapsed-time.ts`

Hook that returns `{ formatted: string, ms: number }`:

- Accepts `startTime: number | null`
- 1s `setInterval` (not sub-second — sufficient for long inferences)
- Formats: `0m 05s`, `2m 14s`, `1h 23m`
- Returns `{ formatted: '0m 00s', ms: 0 }` when startTime is null

#### 4. `apps/client/src/hooks/use-rotating-verb.ts`

Hook that returns `{ verb: string, key: string }`:

- Accepts `verbs: string[]`, `intervalMs: number`
- Random selection (no consecutive repeats)
- Incrementing `key` for AnimatePresence crossfade tracking

#### 5. `apps/client/src/components/chat/InferenceIndicator.tsx`

Main component with two visual states:

**Props:**

```typescript
interface InferenceIndicatorProps {
  status: 'idle' | 'streaming' | 'error';
  streamStartTime: number | null;
  estimatedTokens: number;
  theme?: IndicatorTheme;
}
```

**Streaming state:**

- `motion.div` entrance: 200ms fade-in + 4px y-slide
- Shimmer asterisk via CSS `animation` property referencing theme's `iconAnimation`
- Nested `AnimatePresence mode="wait"` for verb crossfade (300ms, opacity + 2px y-shift)
- Elapsed time in `text-muted-foreground/70`
- Token estimate in `text-muted-foreground/60`
- All text in `text-2xs`

**Complete state:**

- Transitions in-place (same container height)
- Summary: `{elapsed} · {tokens}` in `text-3xs text-muted-foreground/50`
- 150ms opacity fade to 60%

**Null render** when idle with no recent activity (no tokens accumulated).

### Modified Files

#### 6. `apps/client/src/hooks/use-chat-session.ts`

Add to the hook:

- `streamStartTimeRef = useRef<number | null>(null)`
- `estimatedTokensRef = useRef<number>(0)`

In `handleStreamEvent`:

- `text_delta`: Set `streamStartTimeRef.current = Date.now()` on first delta, accumulate `text.length / 4` into `estimatedTokensRef`
- `done`: Reset both refs to null/0

Add to return object: `streamStartTime`, `estimatedTokens`

#### 7. `apps/client/src/components/chat/ChatPanel.tsx`

Destructure `streamStartTime`, `estimatedTokens` from `useChatSession`. Pass both to `<MessageList>`.

#### 8. `apps/client/src/components/chat/MessageList.tsx`

Add props: `streamStartTime?: number | null`, `estimatedTokens?: number`.

Render `<InferenceIndicator>` after virtual items, inside the scroll container. Position absolutely below the last virtual item:

```tsx
<div style={{ position: 'absolute', top: virtualizer.getTotalSize(), left: 0, width: '100%' }}>
  <InferenceIndicator
    status={status}
    streamStartTime={streamStartTime}
    estimatedTokens={estimatedTokens}
  />
</div>
```

Auto-scroll behavior unchanged — existing scroll trigger naturally keeps indicator visible.

#### 9. `apps/client/src/index.css`

Add after existing `blink-cursor` keyframe:

```css
@keyframes shimmer-pulse {
  0%,
  100% {
    opacity: 0.6;
    transform: scale(1);
  }
  50% {
    opacity: 1;
    transform: scale(1.15);
  }
}
```

2s duration, ease-in-out, GPU-accelerated (opacity + transform only). Automatically respects existing `prefers-reduced-motion` CSS rule.

---

## Accessibility

- Icon: `aria-hidden="true"` (decorative)
- Motion: Respects `prefers-reduced-motion` via `<MotionConfig reducedMotion="user">` at app level
- Reduced motion fallback: Static asterisk, text rotation without animation, still shows time/tokens
- Color contrast: `text-muted-foreground` variants meet WCAG AA for small text
- Screen readers: Text content is semantic and readable

## Mobile

- All text/icons use CSS custom property tokens (`text-2xs`, `text-3xs`) which scale automatically via `--mobile-scale: 1.25`
- Compact horizontal layout fits 320px+ viewports
- Indicator is non-interactive (no touch targets needed)

---

## Testing

### Unit Tests (New Files)

- `apps/client/src/hooks/__tests__/use-elapsed-time.test.ts` — Time formatting for 0s, 65s, 83min cases; null startTime; interval cleanup
- `apps/client/src/hooks/__tests__/use-rotating-verb.test.ts` — Initial verb, rotation after interval, key increments, no consecutive repeats
- `apps/client/src/components/chat/__tests__/InferenceIndicator.test.tsx` — Streaming state renders all elements; complete state shows summary; idle returns null; token formatting < 1000 and >= 1000

### Unit Tests (Extended)

- `use-chat-session.test.ts` — `streamStartTime` set on first text_delta; `estimatedTokens` accumulates; reset on done

### Manual Checklist

- [ ] Indicator appears during streaming, below last message
- [ ] Asterisk shimmer animation plays
- [ ] Verb rotates every ~3.5s with crossfade
- [ ] Elapsed time updates every second
- [ ] Token count increases as text streams
- [ ] Completion: collapses to compact summary, no layout shift
- [ ] Dark mode: text colors readable
- [ ] `prefers-reduced-motion`: animations disabled, content still shows
- [ ] Mobile viewport: text scales correctly
- [ ] Auto-scroll keeps indicator visible
- [ ] Fast response (<5s): appears and collapses quickly
- [ ] Long response (>1min): time format adapts
- [ ] `turbo build` passes

---

## Implementation Phases

### Phase 1: Core Hooks & Data

1. Create `inference-verbs.ts` (50 custom verbs)
2. Create `inference-themes.ts` (interface + DEFAULT_THEME)
3. Create `use-elapsed-time.ts` + tests
4. Create `use-rotating-verb.ts` + tests

### Phase 2: Timing Integration

1. Modify `use-chat-session.ts` — add refs, intercept events, export values
2. Add/extend tests for timing

### Phase 3: UI Component

1. Add `shimmer-pulse` keyframe to `index.css`
2. Create `InferenceIndicator.tsx` + tests
3. Verify animations manually

### Phase 4: Wiring

1. Modify `ChatPanel.tsx` — pass new props
2. Modify `MessageList.tsx` — render indicator after virtual items
3. End-to-end manual testing

### Phase 5: Polish

1. Full manual checklist
2. Motion preference testing
3. Mobile + dark mode
4. `turbo build` verification

---

## Open Questions

_None — all design decisions finalized in ideation phase._
