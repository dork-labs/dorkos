---
slug: chat-streaming-motion
number: 152
created: 2026-03-20
status: specified
authors:
  - Claude Code
---

# Chat Streaming Motion — Premium Text & Scroll Animation

## Status

Specified

## Overview

Make the chat streaming experience feel dramatically smoother and more premium by enabling per-word text animation during streaming and replacing the custom instant-scroll logic with spring-based smooth scrolling. Add simulator controls to toggle and compare text effects for visual QA.

## Background / Problem Statement

The current chat experience has two polish gaps:

1. **Streamed text chunks appear abruptly.** When tokens arrive from the LLM, they're appended to the DOM with no visual transition. The only streaming feedback is a blinking cursor. Production AI chat UIs (Perplexity) have demonstrated that per-word blur-in animation creates a noticeably more premium feel.

2. **The message list jumps during streaming.** Auto-scroll sets `scrollTop = scrollHeight - clientHeight` directly, which causes micro-jumps as content grows. The browser's native scroll anchoring (`overflow-anchor`) can also conflict with programmatic scroll, exacerbating the problem.

Both issues are solvable with existing tools — `streamdown` already ships an `animated` prop (confirmed in v2.4.0 types), and `use-stick-to-bottom` provides spring-interpolated scroll specifically designed for AI chat streaming.

## Goals

- Per-word text animation during streaming (blur-in default) with zero new DOM overhead on completed messages
- Spring-based smooth scroll that eliminates micro-jumps during streaming
- Swappable text effect architecture (`TextEffectMode`) for easy effect iteration
- `prefers-reduced-motion` auto-disables all text animation
- Dev simulator controls to toggle effect mode and animation on/off
- Preserve existing scroll behavior: user scroll-up detachment, scroll-to-bottom button, Obsidian visibility detection

## Non-Goals

- Exposing text effect mode in user Settings (design decision only)
- Character-level animation (word-level is the performance sweet spot)
- Server-side token smoothing (Vercel AI SDK `smoothStream` pattern)
- Changing message entry animations (spring physics in `MessageItem.tsx` are already solid)
- Modifying tool call card animations (AnimatePresence lifecycle is working well)

## Technical Dependencies

| Dependency | Version | Status | Purpose |
|---|---|---|---|
| `streamdown` | ^2.4.0 | Already installed | `animated` prop, `isAnimating` prop |
| `use-stick-to-bottom` | latest | **New dependency** | Spring-based scroll for streaming |
| `motion/react` | existing | Already installed | Unaffected (message entry animations) |
| `@tanstack/react-virtual` | existing | Already installed | Unaffected (virtualization) |

## Detailed Design

### 1. TextEffectConfig System

**New file:** `apps/client/src/layers/shared/lib/text-effects.ts`

```typescript
import type { AnimateOptions } from 'streamdown';

/** Available text streaming animation modes. */
export type TextEffectMode = 'none' | 'fade' | 'blur-in' | 'slide-up';

/** Configuration for text streaming animation. */
export interface TextEffectConfig {
  mode: TextEffectMode;
  duration?: number;
  easing?: string;
  sep?: 'word' | 'char';
}

/** Default text effect: Perplexity-style blur-in at word level. */
export const DEFAULT_TEXT_EFFECT: TextEffectConfig = {
  mode: 'blur-in',
  duration: 150,
  easing: 'ease-out',
  sep: 'word',
};

/** Map from TextEffectMode → streamdown's animation preset name. */
const MODE_TO_ANIMATION: Record<TextEffectMode, AnimateOptions['animation'] | undefined> = {
  'none': undefined,
  'fade': 'fadeIn',
  'blur-in': 'blurIn',
  'slide-up': 'slideUp',
};

/**
 * Resolve a TextEffectConfig into streamdown's `animated` prop value.
 * Returns `false` when mode is 'none' (disables animation entirely).
 */
export function resolveStreamdownAnimation(
  config: TextEffectConfig
): false | AnimateOptions {
  const animation = MODE_TO_ANIMATION[config.mode];
  if (!animation) return false;
  return {
    animation,
    duration: config.duration ?? 150,
    easing: config.easing ?? 'ease-out',
    sep: config.sep ?? 'word',
  };
}

/**
 * Return a resolved text effect config that respects prefers-reduced-motion.
 * When reduced motion is preferred, returns mode 'none' regardless of input.
 */
export function useTextEffectConfig(
  preferred: TextEffectConfig = DEFAULT_TEXT_EFFECT
): TextEffectConfig {
  // Check at module level for SSR safety
  if (typeof window === 'undefined') return preferred;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reducedMotion) return { ...preferred, mode: 'none' };
  return preferred;
}
```

**Export from barrel:** Add to `apps/client/src/layers/shared/lib/index.ts`:
```typescript
export { DEFAULT_TEXT_EFFECT, resolveStreamdownAnimation, useTextEffectConfig } from './text-effects';
export type { TextEffectMode, TextEffectConfig } from './text-effects';
```

### 2. StreamingText Enhancement

**Modified file:** `apps/client/src/layers/features/chat/ui/StreamingText.tsx`

Changes:
- Accept optional `textEffect` prop of type `TextEffectConfig`
- Default to `DEFAULT_TEXT_EFFECT` when not provided
- Call `resolveStreamdownAnimation()` and pass result to Streamdown's `animated` prop
- Pass `isAnimating={isStreaming}` to Streamdown (controls whether animation spans are generated)

```typescript
import { DEFAULT_TEXT_EFFECT, resolveStreamdownAnimation } from '@/layers/shared/lib';
import type { TextEffectConfig } from '@/layers/shared/lib';

interface StreamingTextProps {
  content: string;
  isStreaming?: boolean;
  textEffect?: TextEffectConfig;
}

export function StreamingText({
  content,
  isStreaming = false,
  textEffect = DEFAULT_TEXT_EFFECT,
}: StreamingTextProps) {
  const animatedConfig = resolveStreamdownAnimation(textEffect);

  return (
    <div className={cn('relative', isStreaming && 'streaming-cursor')}>
      <Streamdown
        shikiTheme={['github-light', 'github-dark']}
        linkSafety={linkSafety}
        animated={animatedConfig}
        isAnimating={isStreaming}
      >
        {content}
      </Streamdown>
    </div>
  );
}
```

**Required:** Add `import 'streamdown/styles.css'` to `StreamingText.tsx`. This file contains the `@keyframes` for `sd-fadeIn`, `sd-blurIn`, `sd-slideUp` and the `[data-sd-animate]` selector — without it, animation spans render but have no visual effect.

### 3. AssistantMessageContent Threading

**Modified file:** `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx`

The `textEffect` prop must flow from `MessageList` → `MessageItem` → `AssistantMessageContent` → `StreamingText`. Two approaches:

**Option A (props):** Add `textEffect` to `MessageContext` (already used by `AssistantMessageContent`). This avoids prop drilling since `MessageContext` already provides `isStreaming`, `sessionId`, etc.

```typescript
// In MessageContext, add:
textEffect?: TextEffectConfig;

// In AssistantMessageContent, read from context:
const { textEffect, ...rest } = useMessageContext();

// Pass to StreamingText:
<StreamingText content={part.text} isStreaming={...} textEffect={textEffect} />
```

**Option B (hook):** Call `useTextEffectConfig()` directly inside `StreamingText`. Simpler, but doesn't allow the simulator to override the config.

**Decision:** Use Option A (MessageContext) because the simulator needs to inject a custom `textEffect` config. `MessageContext` already handles this pattern for other passthrough values.

### 4. Spring-Based Smooth Scroll

**Modified file:** `apps/client/src/layers/features/chat/ui/MessageList.tsx`

Replace the custom scroll logic with `use-stick-to-bottom`. The library provides two integration patterns:

**Hook-based (preferred):** `useStickToBottom()` returns refs and state that integrate with the existing MessageList structure.

```typescript
import { useStickToBottom } from 'use-stick-to-bottom';

// Inside MessageList:
const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom({
  resize: 'smooth',      // Spring-animated resize following
  initial: 'smooth',     // Spring-animated initial scroll
});
```

**Integration with TanStack Virtual:**

The key challenge is that TanStack Virtual uses absolute positioning (`transform: translateY(Npx)`) with a wrapper div whose height equals `virtualizer.getTotalSize()`. `use-stick-to-bottom` observes content height via ResizeObserver — this should work naturally since the content wrapper's height changes as the virtualizer recalculates.

```tsx
// scrollRef wraps the outer scroll container (currently parentRef)
<div ref={scrollRef} className="chat-scroll-area hide-scrollbar h-full overflow-y-auto pt-12"
     style={{ overflowAnchor: 'none' }}>
  {/* contentRef wraps the virtualizer content area */}
  <div ref={contentRef} style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
    {virtualizer.getVirtualItems().map((virtualRow) => (
      // ... existing virtual rows
    ))}
  </div>
</div>
```

**What gets removed:**

The following custom scroll logic in `MessageList.tsx` is replaced by `use-stick-to-bottom`:
- ResizeObserver on `contentRef` (lines 207-232)
- Message count fallback effect (lines 234-244)
- `scrollToBottom` callback (lines 246-251)
- `handleScroll` callback and scroll event listener (lines 119-176)
- `isAtBottomRef`, `isTouchActiveRef`, `isUserScrollingRef`, `clearScrollIntentTimerRef` refs

**What stays:**

- `historyCount` state and `isNew` gate (message entry animation, unrelated to scroll)
- Obsidian IntersectionObserver visibility detection (lines 181-204) — `use-stick-to-bottom` doesn't handle this case. Keep it, using `scrollToBottom()` from the library.
- `useImperativeHandle` exposing `scrollToBottom` — now delegates to `use-stick-to-bottom`'s `scrollToBottom`
- `onScrollStateChange` callback — map from `use-stick-to-bottom`'s `isAtBottom` state

**Mapping `isAtBottom` to `useScrollOverlay`:**

`useScrollOverlay` needs `onScrollStateChange({ isAtBottom, distanceFromBottom })`. Use an effect to sync:

```typescript
useEffect(() => {
  onScrollStateChange?.({
    isAtBottom,
    distanceFromBottom: isAtBottom ? 0 : 200, // Approximate; library doesn't expose exact distance
  });
}, [isAtBottom, onScrollStateChange]);
```

**CSS fix:** Add `overflow-anchor: none` to the scroll container. This prevents the browser's native scroll anchoring from conflicting with `use-stick-to-bottom`'s spring scroll:

```css
.chat-scroll-area {
  overflow-anchor: none;
}
```

### 5. Simulator Effect Toggle Controls

**Modified file:** `apps/client/src/dev/pages/SimulatorPage.tsx`

Add state for effect configuration:

```typescript
const [textEffectMode, setTextEffectMode] = useState<TextEffectMode>('blur-in');
const [animationEnabled, setAnimationEnabled] = useState(true);

const textEffect: TextEffectConfig = animationEnabled
  ? { mode: textEffectMode, duration: 150, easing: 'ease-out', sep: 'word' }
  : { mode: 'none' };
```

Pass down to both controls and chat panel.

**Modified file:** `apps/client/src/dev/simulator/SimulatorControls.tsx`

Add an effect controls row below the existing transport controls:

```tsx
{/* Effect controls */}
<div className="flex items-center gap-3 mt-2 pt-2 border-t border-dashed">
  <span className="text-muted-foreground text-xs">Text Effect</span>
  <Select value={textEffectMode} onValueChange={onTextEffectModeChange}>
    <SelectTrigger className="h-7 w-32 text-xs">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="none">None</SelectItem>
      <SelectItem value="fade">Fade In</SelectItem>
      <SelectItem value="blur-in">Blur In</SelectItem>
      <SelectItem value="slide-up">Slide Up</SelectItem>
    </SelectContent>
  </Select>

  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
    <Switch
      checked={animationEnabled}
      onCheckedChange={onAnimationEnabledChange}
      className="scale-75"
    />
    Animation
  </label>
</div>
```

**Modified file:** `apps/client/src/dev/simulator/SimulatorChatPanel.tsx`

Accept `textEffect` prop and pass it through to `MessageList` (which passes it via `MessageContext` to `StreamingText`):

```typescript
interface SimulatorChatPanelProps {
  sim: SimulatorResult;
  textEffect?: TextEffectConfig;
}
```

## User Experience

**During streaming:**
- Each word of the assistant's response fades/blurs in individually over ~150ms
- The scroll smoothly follows new content with spring physics (no jumps)
- The blinking cursor remains at the end of the last word (existing behavior)

**After streaming completes:**
- All animation spans are removed from the DOM (streamdown handles this automatically when `isAnimating` is `false`)
- No visual difference from current behavior for completed messages

**When user scrolls up during streaming:**
- Auto-scroll detaches (built into `use-stick-to-bottom`)
- "New messages" and "Scroll to bottom" buttons appear (existing behavior via `useScrollOverlay`)
- Clicking either button smooth-scrolls to bottom and re-engages auto-follow

**Reduced motion:**
- `prefers-reduced-motion: reduce` auto-disables all text animation
- Text appears instantly as today (zero regression)

**In the simulator:**
- The effect mode dropdown lets the developer switch between none/fade/blur-in/slide-up in real time
- The animation toggle enables/disables the entire text effect system
- Each of the 9 existing scenarios renders correctly with all effect modes

## Testing Strategy

### Unit Tests

**`layers/shared/lib/__tests__/text-effects.test.ts`:**
- `resolveStreamdownAnimation` returns `false` for mode `'none'`
- `resolveStreamdownAnimation` maps `'blur-in'` → `{ animation: 'blurIn', ... }`
- `resolveStreamdownAnimation` maps `'fade'` → `{ animation: 'fadeIn', ... }`
- `resolveStreamdownAnimation` maps `'slide-up'` → `{ animation: 'slideUp', ... }`
- `resolveStreamdownAnimation` uses provided duration/easing/sep overrides
- `useTextEffectConfig` returns `mode: 'none'` when `matchMedia('(prefers-reduced-motion: reduce)')` matches

**`layers/features/chat/__tests__/StreamingText.test.tsx`:**
- Passes `animated` prop to Streamdown when `textEffect` mode is not `'none'`
- Passes `animated={false}` when `textEffect.mode` is `'none'`
- Passes `isAnimating={true}` when `isStreaming` is true
- Passes `isAnimating={false}` when `isStreaming` is false
- Defaults to `DEFAULT_TEXT_EFFECT` when no `textEffect` prop provided

**`layers/features/chat/__tests__/MessageList.test.tsx`:**
- Existing tests pass (may need mock updates for `use-stick-to-bottom`)
- Mock `use-stick-to-bottom` to return `{ scrollRef, contentRef, isAtBottom: true, scrollToBottom: vi.fn() }`
- `scrollToBottom` is exposed via imperative handle
- `onScrollStateChange` fires when `isAtBottom` changes
- `overflow-anchor: none` is present on scroll container

### Integration Tests

- Simulator renders all 9 scenarios without errors when text effect is `'blur-in'`
- Simulator renders all 9 scenarios without errors when text effect is `'none'`
- Switching text effect mode mid-scenario does not crash
- Streamdown receives correct `animated` config from the TextEffectConfig pipeline

### Visual QA (Manual via Simulator)

- Run each scenario at 1x speed with each effect mode, verify:
  - Words animate individually (not entire chunks)
  - Code blocks render correctly (no animation inside `<pre>` blocks)
  - Links and inline code are not disrupted
  - Markdown tables render without animation artifacts
  - Long messages scroll smoothly during playback

## Performance Considerations

| Concern | Mitigation |
|---|---|
| Span proliferation during streaming | Word-level splitting: ~180 spans per 1000 chars. Acceptable. Character-level (~1000 spans) explicitly avoided via `sep: 'word'`. |
| Residual DOM nodes on completed messages | Streamdown excludes animation spans when `isAnimating={false}`. No residual overhead. |
| GPU compositing | Only `opacity`, `transform`, and `filter: blur()` are animated — all GPU-composited, no layout thrashing. |
| `filter: blur()` cost | One-shot mount animation (< 8px blur) is acceptable. Not continuously animated. |
| `will-change` | Never applied to individual word spans. Only on containing message wrapper if needed. |
| Spring scroll overhead | `use-stick-to-bottom` uses requestAnimationFrame internally. Minimal overhead vs. existing RAF-based scroll. |

## Security Considerations

No security impact. All changes are client-side rendering and scroll behavior. No new data flows, network requests, or authentication changes.

## Documentation

- Update `contributing/animations.md` with text effect system documentation
- Add `TextEffectMode` and `TextEffectConfig` to the shared lib API section
- Document simulator effect controls in dev playground documentation (if it exists)

## Implementation Phases

### Phase 1: Text Effect System + Streamdown Integration

1. Create `layers/shared/lib/text-effects.ts` with types, config, resolver, hook
2. Export from `layers/shared/lib/index.ts`
3. Update `StreamingText.tsx` to accept `textEffect` prop and pass to Streamdown
4. Thread `textEffect` through `MessageContext` → `AssistantMessageContent`
5. Add `overflow-anchor: none` to `.chat-scroll-area` in `index.css`
6. Write unit tests for `text-effects.ts` and `StreamingText.tsx`
7. Verify `streamdown/styles.css` import requirement

### Phase 2: Spring Scroll Migration

1. Install `use-stick-to-bottom` dependency
2. Replace custom scroll logic in `MessageList.tsx` with `useStickToBottom`
3. Preserve Obsidian IntersectionObserver visibility detection
4. Map `isAtBottom` state to `onScrollStateChange` for `useScrollOverlay` compatibility
5. Verify `ScrollThumb` still works with new scroll container ref
6. Update `MessageList` tests with `use-stick-to-bottom` mock
7. Manual QA: test scroll behavior during streaming, user scroll-up, scroll-to-bottom buttons

### Phase 3: Simulator Effect Controls

1. Add effect state to `SimulatorPage.tsx`
2. Add effect selector dropdown and animation toggle to `SimulatorControls.tsx`
3. Wire `textEffect` config through `SimulatorChatPanel.tsx`
4. Test all 9 scenarios with each effect mode
5. Verify switching modes mid-scenario works cleanly

## Open Questions

1. ~~**`streamdown/styles.css` import**~~ (RESOLVED)
   **Answer:** Yes, the import is required. `streamdown/styles.css` contains `@keyframes sd-fadeIn`, `sd-blurIn`, `sd-slideUp` and the `[data-sd-animate]` selector rule. Without this import, the animated spans render but have no visual animation. Add `import 'streamdown/styles.css'` in `StreamingText.tsx`.

2. ~~**`use-stick-to-bottom` + TanStack Virtual**~~ (RESOLVED)
   **Answer:** Likely compatible — verify during implementation. The virtualizer sets height via inline style on a wrapper div; ResizeObserver should detect this. If it doesn't fire, add a minimal ResizeObserver bridge as fallback.

3. ~~**`ScrollThumb` ref compatibility**~~ (RESOLVED)
   **Answer:** Verify during implementation. Both should be `RefObject<HTMLDivElement>`. If incompatible, create a ref bridge.

4. ~~**`distanceFromBottom` approximation**~~ (RESOLVED)
   **Answer:** Boolean approximation is sufficient. `useScrollOverlay` only consumes `isAtBottom` downstream — `distanceFromBottom` is not used by any consumer. Pass `{ isAtBottom, distanceFromBottom: isAtBottom ? 0 : 200 }`.

## Related ADRs

- **ADR-0092:** Gate Auto-Scroll Disengagement Behind User Scroll Intent — The current scroll intent detection pattern being replaced. `use-stick-to-bottom` provides equivalent behavior built-in.
- **ADR-0093:** Defer tool_result Re-Render via queueMicrotask — The `queueMicrotask` batching in scroll logic. Verify `use-stick-to-bottom` handles this case.
- **ADR-0114:** Client-Only `_partId` Field for Stable React Keys in Streaming Text Parts — Stable keys enable streamdown's animation plugin to correctly track which words are new vs. existing.

## References

- [Streamdown v2.4.0 TypeScript types](node_modules/.pnpm/streamdown@2.4.0.../dist/index.d.ts) — Confirmed `animated`, `isAnimating`, `AnimateOptions`, `createAnimatePlugin` exports
- [use-stick-to-bottom GitHub](https://github.com/stackblitz-labs/use-stick-to-bottom) — Spring-based scroll library
- [Ideation document](specs/chat-streaming-motion/01-ideation.md) — Full research and decision log
- [Research: Chat message list animations](research/20260320_chat_message_list_animations.md)
- [Research: LLM streaming text animation techniques](research/20260320_llm_streaming_text_animation_techniques.md)
