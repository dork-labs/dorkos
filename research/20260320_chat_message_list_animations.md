---
title: 'Chat Message List Animations — Production Techniques for Smooth AI Chat UIs'
date: 2026-03-20
type: external-best-practices
status: active
tags:
  [
    animation,
    chat-ui,
    scroll,
    framer-motion,
    motion-dev,
    auto-scroll,
    stick-to-bottom,
    react-virtuoso,
    FLIP,
    starting-style,
    streaming,
    virtualization,
  ]
searches_performed: 14
sources_count: 38
---

# Chat Message List Animations — Production Techniques for Smooth AI Chat UIs

## Research Summary

This report covers the four areas of chat UI animation as requested: (1) how premium chat UIs animate new message entry; (2) how smooth auto-scroll during AI streaming is handled — including the critical "detach/reattach" pattern when the user scrolls up; (3) the current state of layout animation libraries (Motion, auto-animate, FLIP, React Spring, `@starting-style`, View Transitions); and (4) the state of the art for animated lists combined with React virtualization.

The primary production takeaway is that **`use-stick-to-bottom` (StackBlitz Labs) is now the industry-standard library for streaming chat scroll**, replacing fragile DIY solutions. For entry animations, the production consensus is **opacity + translateY with spring physics, no per-character typewriter animation**. For virtualized lists, combining TanStack Virtual with motion.dev requires care — the "conditional animation scheduling" pattern is the only viable approach for exit animations on virtual rows.

---

## Key Findings

### 1. New Message Entry Animations — What Production Apps Actually Do

The industry has converged on a tight, minimal pattern across all premium chat UIs:

- **Opacity + translateY only**: The universal pattern is `opacity: 0 → 1` combined with `translateY: 8–12px → 0`. No scale, no rotation, no blur.
- **User messages**: Slightly more pronounced offset (y: 10–12px), sometimes with a very subtle scale pop (`scale: 0.97 → 1`). iMessage uses a scale-from-send-button animation; web implementations approximate it.
- **AI/assistant messages**: Smaller offset (y: 6–8px), no scale. The intent is "content arriving from below," not a directional throw.
- **Duration**: 150–250ms. Anything longer feels sluggish. Claude.ai and ChatGPT are both estimated at ~200ms.
- **Spring physics preferred over CSS easing**: Springs respond naturally to interruption (the user clicking away mid-animation). Duration-based animations don't. For content-arrival animations, `stiffness: 280–320, damping: 28–32` is the production sweet spot.
- **History items must NOT animate**: Using `initial={false}` on the `AnimatePresence` wrapper or gating with an `isNew` flag prevents the entire message history from animating on load. This is non-negotiable UX — animating 50 messages on mount is disorienting.
- **The AI container enters on first token, not on message completion**: Claude.ai and ChatGPT both animate the message container in the moment the first streaming token arrives — giving the "AI is responding" signal immediately. The container entrance is the animation; the text itself is not animated character-by-character.

**The typewriter anti-pattern**: Despite many tutorials recommending character-by-character animation, zero production apps use it. ChatGPT, Claude.ai, and Gemini all render tokens directly as they arrive. A blinking cursor (CSS `animation: blink 0.65s steps(1) infinite`) is the only visual feedback during streaming. Character-by-character animation creates artificial delay, breaks accessibility (screen readers queue it), and falls apart when tokens arrive faster than the animation can keep up.

**Layout shift during new message addition**: The correct prevention technique for the message list "jumping" when a new message appears at the bottom is **CSS `overflow-anchor: none`** on the message list container, combined with proper scroll management from JavaScript. Without disabling scroll anchoring, browsers sometimes scroll to maintain the viewport's top-of-screen element position when content is added below the viewport — the opposite of what you want in a chat UI.

```css
/* On the message list container */
.message-list {
  overflow-anchor: none;
}
```

### 2. Smooth Auto-Scroll During Streaming — The Definitive Pattern

This is the area with the most nuance and where most DIY implementations fail.

#### The Problem Space

When streaming content arrives, three behaviors must coexist:

1. If the user is at the bottom, automatically scroll down as content arrives
2. If the user has scrolled up to read earlier content, do NOT fight them — freeze auto-scroll
3. When the user scrolls back to the bottom, re-engage auto-scroll

Naive implementations (calling `scrollIntoView` on every token, or using `useEffect` with `scrollTop = scrollHeight`) fail case 2: they either always auto-scroll (jarring) or never auto-scroll (useless during streaming).

#### The State-of-the-Art Solution: `use-stick-to-bottom`

**`use-stick-to-bottom`** (StackBlitz Labs, zero dependencies, ~2KB) is now the canonical solution for this problem. It's used directly by:

- `shadcn/ui`'s official AI Conversation component
- `prompt-kit`'s `ChatContainer` component
- The Vercel AI SDK's recommended UI patterns

The key innovations in this library:

**Velocity-based spring animation for scrolling** (not easing functions): The library implements its own scroll animation system using physics-based springs rather than CSS `scroll-behavior: smooth` or `scrollIntoView({ behavior: 'smooth' })`. The reason: easing functions have fixed durations, which fail when streaming content arrives at variable rates. A spring with configurable mass/damping/stiffness naturally adapts to content velocity.

```typescript
// Default spring parameters (configurable)
{ damping: 0.7, stiffness: 0.05, mass: 1.25 }

// The scroll velocity calculation per frame:
// velocity = (damping × velocity + stiffness × scrollDifference) / mass
```

**ResizeObserver for content detection**: Rather than watching every React state update, the library uses `ResizeObserver` to detect when the content div grows. This fires reliably when streaming tokens expand content height, without needing explicit React effect dependencies.

**User scroll detection without debouncing**: The library distinguishes user-initiated scroll events from its own programmatic scroll events using event flag tracking (not debouncing, which could miss events). When a user wheel-scroll or touch-scroll upward is detected, `escapedFromLock = true` is set, pausing auto-scroll.

**Reattach when user returns to bottom**: When `scrollDifference` drops below a threshold (user scrolled back to near-bottom), `escapedFromLock` resets automatically.

```typescript
// React usage — two integration patterns:

// Pattern 1: Component API (recommended for new code)
import { StickToBottom } from 'use-stick-to-bottom';

<StickToBottom resize="smooth" initial="instant">
  <StickToBottom.Content>
    {messages.map(msg => <MessageItem key={msg.id} {...msg} />)}
  </StickToBottom.Content>
</StickToBottom>

// Pattern 2: Hook API (for custom wrappers)
import { useStickToBottom } from 'use-stick-to-bottom';

const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom({
  damping: 0.7,
  stiffness: 0.05,
  mass: 1.25,
});
```

The `scrollToBottom()` function returns `Promise<boolean>` — resolves to `true` when scroll completes, `false` if the user cancelled mid-scroll.

**What the prompt-kit `ChatContainer` does** (the shadcn ecosystem pattern):

```tsx
<ChatContainerRoot className="h-full">
  <ChatContainerContent>
    {messages.map((msg) => (
      <MessageItem key={msg.id} {...msg} />
    ))}
  </ChatContainerContent>
  <ChatContainerScrollAnchor />
  <div className="absolute right-4 bottom-4">
    <ScrollButton /> {/* Appears when user has scrolled up */}
  </div>
</ChatContainerRoot>
```

#### Alternative: Intersection Observer Pattern

Before `use-stick-to-bottom` was widely adopted, the Intersection Observer pattern was common:

```typescript
// An invisible div at the bottom of the message list
const bottomAnchorRef = useRef<HTMLDivElement>(null);
const isAtBottomRef = useRef(true);

useEffect(() => {
  const observer = new IntersectionObserver(
    ([entry]) => {
      isAtBottomRef.current = entry.isIntersecting;
    },
    { threshold: 0.1 }
  );
  if (bottomAnchorRef.current) observer.observe(bottomAnchorRef.current);
  return () => observer.disconnect();
}, []);

// During streaming, only scroll if isAtBottomRef.current is true
useEffect(() => {
  if (isAtBottomRef.current && streamingContent) {
    bottomAnchorRef.current?.scrollIntoView({ behavior: 'smooth' });
  }
}, [streamingContent]);
```

**Limitation**: `scrollIntoView({ behavior: 'smooth' })` can feel jerky during fast streaming because each new call interrupts the previous smooth scroll in mid-flight. The velocity-spring approach in `use-stick-to-bottom` handles this by accumulating velocity rather than restarting.

#### `scrollIntoView` vs CSS `scroll-behavior` vs requestAnimationFrame

| Approach                                 | Pro                                                                | Con                                                                              | Best For                                    |
| ---------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------- |
| `scrollIntoView({ behavior: 'smooth' })` | Native, no deps, minimal code                                      | Interrupts itself on rapid calls, limited easing control, Safari issues pre-15.4 | Simple one-shot "scroll to message" actions |
| `CSS scroll-behavior: smooth`            | Pure CSS, composited by browser                                    | No programmatic control, can't pause/override per-event                          | Page-level scroll, not chat streaming       |
| `requestAnimationFrame` manual           | Full control, custom easing                                        | ~30 lines of boilerplate, maintain scroll velocity yourself                      | Custom scroll springs without a library     |
| `use-stick-to-bottom` spring             | Physics-based, handles edge cases, detach/reattach, ResizeObserver | External dependency                                                              | **Production AI chat — the right choice**   |

**Performance note**: `scroll-behavior: smooth` is GPU-composited when the scroll container has its own compositing layer (triggered by `transform`, `will-change`, or overflow). It does NOT trigger layout recalculation. `scrollTo({ behavior: 'smooth' })` is equivalent to the CSS property — both are handled by the browser's scrolling infrastructure off the main thread where possible.

#### react-virtuoso `followOutput` and `VirtuosoMessageList`

React Virtuoso's standard `Virtuoso` component has a `followOutput` prop:

```tsx
<Virtuoso
  data={messages}
  followOutput="smooth" // or true (instant) or (isAtBottom) => boolean function
  itemContent={(index, msg) => <MessageItem {...msg} />}
/>
```

`followOutput="smooth"` uses `scrollTo({ behavior: 'smooth' })` internally. The documented limitation: smooth mode can fall behind on very fast updates (millisecond-level streaming tokens), while `true` (instant) keeps up but looks jerky.

The **`@virtuoso.dev/message-list`** package (commercial, separate from `react-virtuoso`) is purpose-built for AI chat and exposes `autoscrollToBottomBehavior="smooth"` plus a `scrollModifier` API for custom scroll behavior. It handles the detach/reattach pattern natively. However, it's a paid component in the Virtuoso commercial tier.

For DorkOS (which uses TanStack Virtual, not Virtuoso), `use-stick-to-bottom` is the correct pairing.

---

### 3. Layout Animation Libraries — Current State

#### Motion (motion.dev) — The DorkOS Standard

Motion is the successor to Framer Motion. The `motion` package from motion.dev is **already installed in DorkOS** and is the correct choice.

Key capabilities relevant to chat UIs:

**`AnimatePresence`**: Animates components as they exit the React tree. For chat, this handles the case of tool call auto-collapse (`mode="popLayout"` for list reflow, `mode="wait"` for full-panel crossfades).

**`layout` prop / FLIP engine**: `layout="position"` tells motion to FLIP-animate a component's position change. This is how `layoutId` shared-element transitions work (the sidebar active indicator sliding between items). Motion measures the element before and after, then uses `transform: translate()` to animate from old position to new — no layout recalculation during animation.

**Spring presets for chat** (from prior research, confirmed production values):

```typescript
// Message entry — snappy but not bouncy
{ type: 'spring', stiffness: 320, damping: 28, mass: 1 }

// Sidebar active indicator FLIP — smooth glide
{ type: 'spring', stiffness: 280, damping: 32, mass: 1 }
```

**Bundle size**: Motion core is ~4KB. The React-specific additions bring it to ~6KB. Framer Motion (which motion.dev replaces) was ~32KB. This is a meaningful difference for a dev tool UI where load performance matters.

#### auto-animate (FormKit) — Best for Simple Cases

Auto-animate is a **zero-config** library that adds animations to list mutations (add, remove, reorder) with a single ref attachment:

```typescript
import { useAutoAnimate } from '@formkit/auto-animate/react';

function SessionList() {
  const [listRef] = useAutoAnimate();
  return (
    <ul ref={listRef}>
      {sessions.map(s => <SessionItem key={s.id} {...s} />)}
    </ul>
  );
}
```

When a child is added, removed, or reordered, auto-animate fires CSS animations automatically. It uses the FLIP technique internally.

**Size**: ~2.5KB — significantly smaller than Motion.

**Production fit for DorkOS**: Auto-animate is excellent for the session sidebar list (new sessions appearing, sessions being deleted). It is **not** appropriate for the message list because:

1. The message list is virtualized (TanStack Virtual) — auto-animate operates on direct DOM children, not virtual rows
2. Auto-animate's default animations (opacity + slight Y translate) are not as controllable as motion.dev's spring configs

**Performance**: Auto-animate animations are FLIP-based — they only use `transform` and `opacity`, staying on the compositor thread. No layout thrashing.

#### FLIP Technique — How It Works

FLIP (First, Last, Invert, Play) is the underlying technique that makes layout animations GPU-cheap:

1. **First**: Record element's current `getBoundingClientRect()`
2. **Last**: Apply the new layout, record new `getBoundingClientRect()`
3. **Invert**: Apply a `transform: translate(deltaX, deltaY) scale(scaleX, scaleY)` that makes the element APPEAR to still be at its old position
4. **Play**: Animate the transform from that inverted state to `transform: none`

The key insight: you animate `transform`, not `left`/`top`/`width`/`height`. Transforms don't trigger layout recalculation — they run on the GPU compositor thread. The element visually appears to animate between positions, but the actual layout change was instant.

Motion's `layout` prop and auto-animate both implement FLIP automatically. The manual React implementation requires `useLayoutEffect` to measure before/after and `requestAnimationFrame` to apply the animation.

**When FLIP matters for DorkOS**: The sidebar active indicator (layoutId), session drag-to-reorder, and any panel expand/collapse that shifts other elements' positions.

#### React Spring — Physics Library, Not Chat-Optimized

React Spring uses physics springs for animation with different API concepts than motion.dev:

```typescript
import { useSpring, animated } from '@react-spring/web';

// React Spring spring config
const styles = useSpring({
  from: { opacity: 0, y: 10 },
  to: { opacity: 1, y: 0 },
  config: { tension: 280, friction: 60 },
});

<animated.div style={styles}>Content</animated.div>
```

React Spring's spring parameters use `tension` and `friction` (vs motion.dev's `stiffness` and `damping` — mathematically equivalent, different naming).

**DorkOS recommendation**: Don't mix React Spring with motion.dev. DorkOS already has motion.dev and should stay with it. React Spring's primary advantage (physics-heavy 3D/Three.js animations) is not relevant to chat UI.

#### `@starting-style` — CSS-Only Entry Animations

`@starting-style` is a new CSS at-rule that defines initial styles for an element the first time it renders:

```css
/* Basic entry animation — no JavaScript needed */
.message-item {
  opacity: 1;
  transform: translateY(0);
  transition:
    opacity 0.2s ease-out,
    transform 0.2s ease-out;
}

@starting-style {
  .message-item {
    opacity: 0;
    transform: translateY(8px);
  }
}
```

**Browser support (as of 2026)**: Chrome 117+, Edge 117+, Firefox 129+, Safari 17.4+. Baseline Newly Available since August 2024. ~86% global browser support. Progressive enhancement — unsupported browsers just get no animation.

**Critical limitation for chat use**: `@starting-style` only fires when an element is first painted — i.e., when it's added to the DOM or when `display` transitions from `none` to something. It fires only once. This means:

- Works perfectly for: static message list items that mount once and stay
- Does NOT work for: virtual list rows (they reuse DOM elements — no remount when new messages arrive at the same index)
- Does NOT work for: history items that should not animate (cannot be gated with an `isNew` flag without JavaScript)

**Verdict for DorkOS**: `@starting-style` is a compelling future direction for non-virtualized chat UIs (e.g., the session-switch animation overlay, tool call cards), but cannot replace motion.dev's `isNew`-gated animations for the virtualized message list.

```css
/* Good @starting-style use case: dialog/modal entry */
dialog[open] {
  opacity: 1;
  transform: translateY(0);
  transition:
    opacity 0.2s ease-out,
    transform 0.2s ease-out,
    display 0.2s ease-out allow-discrete;

  @starting-style {
    opacity: 0;
    transform: translateY(16px);
  }
}
```

Note: `transition-behavior: allow-discrete` (or the shorthand `allow-discrete` keyword) is required to animate `display` itself, which is a discrete property.

#### View Transitions API — SPA State in 2026

The View Transitions API allows cross-document and same-document visual transitions:

```typescript
// Manual wrapping (current stable approach)
document.startViewTransition(() => {
  setSelectedSession(newSession);
});
```

**React integration status (March 2026)**: React's experimental `<ViewTransition>` component is in `react@canary` — the design is close to final but not in stable React yet. The API:

```tsx
// react@canary / react@experimental
import { unstable_ViewTransition as ViewTransition } from 'react';

<ViewTransition>
  <SessionPanel sessionId={activeSessionId} />
</ViewTransition>;
```

**Practical use for DorkOS today**: View Transitions are best for **page/session switching** — animating the panel transition when switching between sessions. This is separate from the message list item animations. The session-switch crossfade currently done with `AnimatePresence mode="wait"` could be progressively enhanced with View Transitions.

**Performance**: View Transitions take a screenshot of the old state and animate between screenshots using `::view-transition-old` and `::view-transition-new` pseudo-elements. This means zero layout recalculation during the animation — it's purely composited.

**Browser support**: Chrome 111+, Edge 111+ (cross-document: all modern browsers). Firefox does not yet support same-document View Transitions. Requires feature detection for production use.

---

### 4. Virtualized Lists + Animation — The State of the Art

This is the hardest problem in chat UI animation.

#### Why Virtualization Breaks Normal Animation Patterns

TanStack Virtual (and other virtualizers) work by:

1. Rendering only the items visible in the viewport
2. Positioning items with `transform: translateY(offset)` absolutely
3. Reusing DOM nodes — items that scroll out of view may get their DOM nodes reassigned to different data items

This creates three animation problems:

- **No real unmount**: When a virtual item scrolls out of the viewport, its DOM node may not unmount — it may just move off-screen or get reused. `AnimatePresence` cannot track this.
- **No real mount**: A new message appearing at the bottom doesn't "mount" a new DOM element if the virtualizer reuses an existing node.
- **`layout` prop is dangerous**: Motion's `layout` prop uses ResizeObserver to detect layout changes and FLIP-animates. In a virtual list where items' `translateY` positions change constantly (as the user scrolls), this would fire constantly and thrash performance.

#### The Correct Pattern: `isNew` Flag at the Item Level

The pattern already in DorkOS is correct: gate animations with an `isNew` flag that is set only for messages that appeared while the UI was already rendered. History messages (loaded at mount) should never animate:

```typescript
// In the virtualizer item render:
<motion.div
  key={message.id}
  // isNew is true only for messages that arrived after initial load
  initial={message.isNew ? { opacity: 0, y: 8 } : false}
  animate={{ opacity: 1, y: 0 }}
  transition={{ type: 'spring', stiffness: 320, damping: 28 }}
>
  <MessageItem message={message} />
</motion.div>
```

The `initial={false}` / `initial={isNew ? {...} : false}` distinction is the entire trick. When `initial={false}`, Motion skips the entrance animation entirely.

**Edge case**: If a virtual row DOM node is reused (the virtualizer reassigns it to a different message), `isNew` on the new message data will cause an animation even though the DOM node was already visible. This is typically not noticeable in a bottom-appending chat list because new messages only appear at the end — but if implementing an "older messages loaded at top" pattern, extra care is needed.

#### Exit Animations on Virtual Rows

Exit animations (e.g., a message being deleted) are fundamentally incompatible with standard virtualization because the virtualizer removes the DOM node immediately without giving motion a chance to animate it out.

The workaround from production research: **"conditional AnimatePresence scheduling"** — temporarily switch the virtual list to a motion-aware mode when an animation is expected:

```typescript
const [animationMode, setAnimationMode] = useState(false);

// Before deleting a message:
setAnimationMode(true);
await deleteMessage(id);
// After 600ms (longer than exit animation):
setAnimationMode(false);

// In the render:
const ItemWrapper = animationMode ? motion.div : 'div';

// When animationMode is true, wrap list in AnimatePresence
{animationMode ? (
  <AnimatePresence mode="popLayout">
    {virtualizer.getVirtualItems().map(item => (
      <ItemWrapper key={item.key} exit={{ opacity: 0, scale: 0.9 }}>
        ...
      </ItemWrapper>
    ))}
  </AnimatePresence>
) : (
  virtualizer.getVirtualItems().map(item => <div key={item.key}>...</div>)
)}
```

**Performance**: This is safe because TanStack Virtual only renders 5–15 visible items at a time. Re-rendering the visible window with motion components is cheap even if logically it seems expensive.

#### react-virtuoso vs TanStack Virtual for Chat

| Dimension                   | TanStack Virtual                          | react-virtuoso                                                                  |
| --------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------- |
| **Bundle**                  | ~10KB                                     | ~50KB                                                                           |
| **API**                     | Headless hook — you control all rendering | Declarative component                                                           |
| **Built-in scroll control** | None (you add)                            | `followOutput`, `scrollSeekPlaceholders`                                        |
| **Chat-specific features**  | None                                      | `VirtuosoMessageList` (commercial)                                              |
| **Animation compatibility** | Requires `isNew` pattern                  | `followOutput` handles auto-scroll; animation at item level still needs `isNew` |
| **DorkOS fit**              | Already installed and used                | Would require migration                                                         |

**react-virtuoso `followOutput` detail**: `followOutput` accepts:

- `true` — instant scroll to bottom on new item
- `"smooth"` — smooth scroll (may fall behind fast streaming)
- A function `(isAtBottom: boolean) => boolean | "smooth"` — conditional logic

The function form enables the detach/reattach pattern: `return isAtBottom ? "smooth" : false`. This is the most correct usage.

#### Can You Use AnimatePresence Directly on a Virtual List?

No. `AnimatePresence` requires direct React children to track their mount/unmount lifecycle. Virtual list items don't reliably unmount (they may be recycled), so `AnimatePresence` cannot track their exit state. The `isNew` flag approach described above is the only viable pattern that ships in production.

---

## Detailed Implementation Reference

### Scroll Anchor Pattern for DorkOS

The correct implementation for DorkOS's `MessageList` + TanStack Virtual:

```typescript
// In MessageList or the ChatPanel that wraps it:
import { useStickToBottom } from 'use-stick-to-bottom';

function ChatPanel({ sessionId }: { sessionId: string }) {
  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom({
    damping: 0.7,
    stiffness: 0.05,
    mass: 1.25,
  });

  return (
    <div ref={scrollRef} className="overflow-y-auto h-full overflow-anchor-none">
      <div ref={contentRef}>
        <MessageList sessionId={sessionId} />
      </div>
      {!isAtBottom && (
        <button
          onClick={() => scrollToBottom()}
          className="absolute right-4 bottom-4 ..."
        >
          Scroll to bottom
        </button>
      )}
    </div>
  );
}
```

Note: `use-stick-to-bottom` wraps the scroll container; TanStack Virtual operates on the `contentRef` div. They are compatible — TanStack Virtual manages its own absolute positioning within the content div, and `use-stick-to-bottom`'s `ResizeObserver` on `contentRef` detects height growth correctly.

### Session Switch Crossfade

```typescript
// At the ChatPanel level — already in existing research
<AnimatePresence mode="wait">
  <motion.div
    key={sessionId}
    initial={{ opacity: 0 }}
    animate={{ opacity: 1 }}
    exit={{ opacity: 0 }}
    transition={{ duration: 0.15, ease: 'easeInOut' }}
    className="h-full"
  >
    <MessageList sessionId={sessionId} />
  </motion.div>
</AnimatePresence>
```

### Message Entry with Spring (refined from prior research)

```typescript
// In MessageItem, with spring physics instead of duration-based easing
<motion.div
  initial={message.isNew ? { opacity: 0, y: 8 } : false}
  animate={{ opacity: 1, y: 0 }}
  transition={{ type: 'spring', stiffness: 320, damping: 28, mass: 1 }}
>
  {/* User messages: add slight scale */}
  {/* initial={message.isNew ? { opacity: 0, y: 10, scale: 0.97 } : false} */}
```

### `@starting-style` for Non-Virtual Elements (Tool Call Cards, Dialogs)

```css
/* For tool call cards, overlays, dialogs — NOT the virtualized message list */
.tool-call-card {
  opacity: 1;
  transform: translateY(0);
  transition:
    opacity 0.2s ease-out,
    transform 0.2s ease-out;
}

@starting-style {
  .tool-call-card {
    opacity: 0;
    transform: translateY(8px);
  }
}
```

---

## Performance Concerns by Technique

| Technique                                          | Triggers Layout?              | Triggers Paint? | Thread                | Notes                                                                              |
| -------------------------------------------------- | ----------------------------- | --------------- | --------------------- | ---------------------------------------------------------------------------------- |
| `transform` + `opacity` animation                  | No                            | No              | Compositor (GPU)      | The only safe animated properties                                                  |
| `height` animation                                 | Yes (layout)                  | Yes             | Main thread           | Avoid. Use `scaleY` + `transform-origin` instead                                   |
| `top/left` position animation                      | Yes (layout)                  | Yes             | Main thread           | Never animate these                                                                |
| `scroll-behavior: smooth` / `scrollTo`             | No                            | No              | Browser scroll thread | Safe. Not blocked by main thread JS                                                |
| `use-stick-to-bottom` spring scroll                | No                            | No              | rAF on main thread    | Minimal — just reads/writes scrollTop                                              |
| FLIP (`motion layout`)                             | No (after First/Last measure) | No              | Compositor            | First+Last snapshot IS a layout read — batch carefully                             |
| ResizeObserver (auto-animate, use-stick-to-bottom) | Reads layout                  | No              | Main thread callback  | Can cause layout thrashing if combined with forced layout writes in the same frame |
| `@starting-style`                                  | No                            | No              | Compositor            | Pure CSS, GPU-accelerated                                                          |
| View Transitions API                               | No (screenshots)              | No              | Compositor            | Heaviest setup, lightest runtime                                                   |

**Critical rule**: Never read layout (e.g., `getBoundingClientRect`, `offsetHeight`) and then immediately write to the DOM in the same synchronous block. This forces a layout recalculation ("layout thrashing"). Use `requestAnimationFrame` to separate reads from writes if you need both.

---

## What Claude.ai and ChatGPT Actually Do (Inferred from Behavior)

These apps' source is minified and uses token-based class names — direct CSS inspection is unreliable. This section is inferred from behavior analysis, GitHub issues, and community reverse-engineering.

**ChatGPT auto-scroll behavior**:

- While streaming: auto-scrolls to follow output if user is at bottom
- User scrolls up: auto-scroll pauses immediately — no fighting
- User scrolls back to bottom: auto-scroll resumes
- There is no visual "scroll to bottom" button — ChatGPT assumes the user knows to scroll
- The scroll animation during streaming is notably smooth (not jarring), suggesting a spring-based or rAF-based approach rather than repeated `scrollIntoView` calls

**Claude.ai auto-scroll behavior**:

- Same pattern as ChatGPT
- Claude.ai's extension (VSCode) was criticized in GitHub issue #11092 for NOT pausing auto-scroll when user scrolls up — demonstrating that the detach pattern is a deliberate UX decision, not a default browser behavior

**Message entry animation** (both):

- Container fades in from y:8 on first token — imperceptible but present
- No per-character animation
- Blinking cursor during streaming
- No animation for history messages on load

---

## Research Gaps & Limitations

- Direct DOM/CSS inspection of Claude.ai and ChatGPT is unreliable due to minified, token-based class names that change on deployment. Animation timings and spring values are inferred.
- `react-virtuoso`'s `VirtuosoMessageList` (commercial) was not directly accessible for testing. The free `followOutput` API is well-documented; the commercial component's full capabilities are not fully mapped here.
- `@starting-style` with discrete properties (`display`, `visibility`) has subtle ordering requirements (Chrome 130+ requires `@starting-style` to come after the target state declaration when nested) that could cause silent failures.
- View Transitions API + React `@canary` is still pre-stable. The `<ViewTransition>` component API may change before reaching stable React.

---

## Contradictions & Disputes

- **`use-stick-to-bottom` vs `followOutput` in react-virtuoso**: Both handle the detach/reattach pattern, but via different mechanisms. `use-stick-to-bottom` uses ResizeObserver + spring animation and is framework-agnostic. `followOutput` is Virtuoso-specific and uses `scrollTo({ behavior: 'smooth' })`. For TanStack Virtual (DorkOS's current setup), `use-stick-to-bottom` is the correct pairing.
- **`@starting-style` vs motion.dev for entry animations**: `@starting-style` is simpler and has no JS runtime cost, but cannot be gated with an `isNew` flag and doesn't work with virtualized lists. They solve overlapping but not identical problems. For a virtualized chat list, motion.dev with `initial={isNew ? {...} : false}` remains necessary.
- **Auto-animate vs motion.dev for session sidebar**: Auto-animate is simpler (1 line, 2.5KB) and handles list reordering/add/remove automatically. Motion.dev's `layoutId` offers more control (spring config, shared-element morphing). Auto-animate is not a drop-in replacement for layoutId — it can't do the "active indicator slides between items" effect. Both could coexist for different purposes.

---

## Sources & Evidence

- `use-stick-to-bottom` — velocity-based spring scroll algorithm for AI chat: [GitHub - stackblitz-labs/use-stick-to-bottom](https://github.com/stackblitz-labs/use-stick-to-bottom)
- Spring params (damping 0.7, stiffness 0.05, mass 1.25) and ResizeObserver architecture: [DeepWiki — use-stick-to-bottom](https://deepwiki.com/stackblitz-labs/use-stick-to-bottom)
- `prompt-kit` ChatContainer implementation using use-stick-to-bottom: [Chat Container - prompt-kit](https://www.prompt-kit.com/docs/chat-container)
- shadcn AI Conversation component built on use-stick-to-bottom: [React AI Conversation - shadcn](https://www.shadcn.io/ai/conversation)
- react-virtuoso `followOutput` and `VirtuosoMessageList`: [React Virtuoso](https://virtuoso.dev/)
- Bouncy scroll issues with react-virtuoso fast updates (Cline): [GitHub Issue #4780 - cline/cline](https://github.com/cline/cline/issues/4780)
- Claude Code VSCode extension feature request for auto-scroll pause on scroll-up: [GitHub Issue #11092 - anthropics/claude-code](https://github.com/anthropics/claude-code/issues/11092)
- How to animate TanStack Virtual list with Motion (conditional AnimatePresence scheduling): [How to animate a TanStack Virtual list with Motion](https://www.devas.life/how-to-animate-a-tanstack-virtual-list-with-motion-rev-2/)
- TanStack Virtual animation discussion: [Animation of row show/hide - TanStack/virtual Discussion #413](https://github.com/TanStack/virtual/discussions/413)
- `@starting-style` Baseline Newly Available: [Now in Baseline: animating entry effects - web.dev](https://web.dev/blog/baseline-entry-animations)
- Josh W. Comeau on `@starting-style` gotchas: [The Big Gotcha With @starting-style](https://www.joshwcomeau.com/css/starting-style/)
- Four new CSS features for entry/exit animations: [Chrome Developers blog](https://developer.chrome.com/blog/entry-exit-animations)
- React View Transitions (canary status, April 2025): [React Labs - View Transitions](https://react.dev/blog/2025/04/23/react-labs-view-transitions-activity-and-more)
- Motion (motion.dev) React docs: [Motion for React](https://motion.dev/docs/react)
- auto-animate FLIP-based zero-config library: [AutoAnimate - FormKit](https://auto-animate.formkit.com/)
- FLIP technique — Aerotwist original: [Aerotwist - FLIP Your Animations](https://aerotwist.com/blog/flip-your-animations/)
- Motion layout/FLIP docs: [Layout Animation — React FLIP | Motion](https://motion.dev/docs/react-layout-animations)
- React animation library comparison 2025: [React Animation Libraries in 2025 - DEV Community](https://dev.to/raajaryan/react-animation-libraries-in-2025-what-companies-are-actually-using-3lik)
- Framer Motion 12 vs React Spring 10 comparison: [Animating React UIs in 2025 - Hooked On UI](https://hookedonui.com/animating-react-uis-in-2025-framer-motion-12-vs-react-spring-10/)
- Motion size (~4KB) vs Framer Motion (~32KB): [Framer Motion vs Motion One Performance - reactlibraries.com](https://reactlibraries.com/blog/framer-motion-vs-motion-one-mobile-animation-performance-in-2025)
- `scrollIntoView` behavior: smooth limitations and usage: [Streaming chat scroll to bottom with React - Dave Lage](https://davelage.com/posts/chat-scroll-react/)
- AI chat scroll behavior debounce + conditional patterns: [Handling scroll behavior for AI Chat Apps - jhakim.com](https://jhakim.com/blog/handling-scroll-behavior-for-ai-chat-apps)
- ChatGPT auto-scroll user complaints: [OpenAI Community - screen auto scrolls](https://community.openai.com/t/screen-auto-scrolls-as-the-response-being-generated/782378)
- CSS animation performance — transform/opacity GPU compositing: [CSS and JavaScript animation performance - MDN](https://developer.mozilla.org/en-US/docs/Web/Performance/Guides/CSS_JavaScript_animation_performance)
- Radix ScrollArea + TanStack Virtual integration: existing research at `research/20260310_radix_scroll_area_tanstack_virtual.md`
- Chat microinteractions (prior research, spring configs, AnimatePresence patterns): existing research at `research/20260309_chat_microinteractions_polish.md`

---

## Search Methodology

- Searches performed: 14
- Most productive terms: "use-stick-to-bottom spring algorithm", "react-virtuoso followOutput streaming scroll lock", "CSS @starting-style entry animation browser support", "TanStack virtual animated list motion", "auto-animate FormKit FLIP performance", "React animation libraries 2025 production"
- Primary information sources: GitHub (stackblitz-labs, TanStack, petyosi, anthropics), motion.dev docs, virtuoso.dev, prompt-kit docs, web.dev, MDN, existing DorkOS research files
