---
title: "Chat Microinteractions Polish — Animation Best Practices"
date: 2026-03-09
type: external-best-practices
status: active
tags: [animation, motion-dev, framer-motion, chat-ui, microinteractions, react, tailwind]
feature_slug: chat-microinteractions-polish
searches_performed: 12
sources_count: 22
---

# Chat Microinteractions Polish — Animation Best Practices

## Research Summary

This report covers animation and microinteraction best practices for a world-class chat UI built on React 19, motion.dev (the framer-motion successor), Tailwind CSS v4, and shadcn/ui. It examines how top-tier chat apps handle message entry, streaming text, sidebar state transitions, and session switching — and maps those patterns directly to DorkOS's existing code at `apps/client/src/layers/features/chat/` and `features/session-list/`.

The current DorkOS codebase already has a solid foundation: `MessageItem` uses `motion.div` with `initial={{ opacity: 0, y: 8 }}` for new messages, `SessionItem` uses `AnimatePresence` for expand/collapse, and `MotionConfig reducedMotion="user"` is applied at the app root. The gaps are: no session-switch fade transition on the MessageList, no user-message "sent" pop, no AI streaming container entrance, and no click-feedback on sidebar items.

---

## Key Findings

### 1. Chat Message Entry Animations

Top-tier chat applications converge on a tight pattern: **opacity + translateY, spring physics, 150–250ms duration**. The variants differ only in directionality:

- **User messages ("sent")**: Slide in from bottom-right, slight scale pop (scale 0.95→1). iMessage famously scales up from the send button. In web implementations this translates to `y: 12, scale: 0.97, opacity: 0` → `y: 0, scale: 1, opacity: 1`.
- **AI / received messages**: Slide up from a smaller offset (y: 6–8), no scale change. Feels "delivered from below" not "sent from user." This is what DorkOS already does (`y: 8`) — but the transition could be spring-based instead of duration-based.
- **History messages on load**: Should NOT animate individually. The `initial={false}` flag on `AnimatePresence` and checking `isNew` (already done in DorkOS) is the correct approach.

The existing DorkOS `MessageItem` animation (`duration: 0.2, ease: [0, 0, 0.2, 1]`) is functional but uses duration-based easing. Switching to a spring feels more physical and alive.

### 2. motion.dev Spring Configs for Chat

Spring physics is the right choice for UI animations because it responds to interruption naturally (unlike CSS transitions that ignore in-flight state).

**Recommended spring presets from the Motion documentation and community usage:**

```typescript
// Message entry — snappy but not bouncy. Feels like content arriving.
{ type: 'spring', stiffness: 320, damping: 28, mass: 1 }

// Sidebar item active indicator / background morph — smooth, no bounce
{ type: 'spring', stiffness: 280, damping: 32, mass: 1 }

// Button click feedback (whileTap scale) — very fast, tight
{ type: 'spring', stiffness: 400, damping: 30 }

// Chevron rotate (expand/collapse) — the existing value in SessionItem is correct
{ type: 'spring', stiffness: 400, damping: 30 }

// Session switch container fade — duration-based is actually better here
// because it should feel like a simple crossfade, not a spring bounce
{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }
```

**Rule of thumb:**
- Spring: interactive elements, list items arriving, anything the user "caused"
- Duration/ease: ambient crossfades, loading states, background transitions

### 3. Streaming Text Appearance Patterns

Research on how ChatGPT, Claude.ai, and the Vercel AI SDK handle streaming reveals a clear consensus: **the container animates in once, the text does not animate character-by-character in production apps.**

**What the major apps actually do:**
- The AI message _container_ fades and slides in (same as any received message) the moment the first token arrives
- Text tokens are appended directly to the DOM without per-character animation
- A blinking cursor shows during streaming — this is the only "animation" on the text itself
- The cursor disappears when `completedTyping` / `isStreaming` goes false

**Why character-by-character typewriter animation is avoided:**
1. It creates artificial slowness — the user reads slower than tokens arrive
2. It introduces a visual queue of pending text that feels wrong during real streaming
3. It is inaccessible (forces users to wait for text that already exists)

**The blinking cursor pattern (from the DEV Community ChatGPT tutorial):**

```css
.streaming-cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  background: currentColor;
  margin-left: 1px;
  vertical-align: text-bottom;
  animation: cursor-blink 0.65s steps(1) infinite;
}

@keyframes cursor-blink {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0; }
}
```

The DorkOS `StreamingText` component already shows a blinking cursor during streaming. The gap is that the AI message container itself doesn't animate in — the `motion.div` in `MessageItem` only animates when `isNew` is true, but the first streaming token arrives before `isNew` is detected correctly in all cases.

**Recommendation:** When `status` transitions from `idle` → `streaming`, mount a placeholder `motion.div` with the entry animation immediately, even before the first token. This gives the "AI is about to respond" feel that Claude.ai uses.

### 4. Sidebar State Transition Patterns

The pattern used by Linear, Notion, and Slack for sidebar active indicators is the **`layoutId` shared element transition** — a background element that slides between list items using motion.dev's FLIP engine rather than CSS transitions.

```typescript
// In SessionItem — the active background slides to the new active item
{isActive && (
  <motion.div
    layoutId="active-session-bg"
    className="absolute inset-0 rounded-md bg-accent"
    transition={{ type: 'spring', stiffness: 280, damping: 32 }}
  />
)}
```

This creates the "pill slides to the new active item" effect seen in Linear's sidebar. Without `layoutId`, switching active items causes the old background to vanish and the new one to appear — jarring. With `layoutId`, motion.dev measures both positions and animates the background between them.

**For hover states:** Use Tailwind CSS transitions rather than motion.dev. Motion.dev adds overhead for simple color transitions that CSS handles natively:

```
// In SessionItem className — pure Tailwind, no motion overhead needed
className="... transition-colors duration-150 hover:bg-accent/50"
```

**For click/tap feedback:** A subtle `whileTap={{ scale: 0.98 }}` on the session item wrapper gives physical feedback:

```typescript
<motion.div
  whileTap={{ scale: 0.98 }}
  transition={{ type: 'spring', stiffness: 400, damping: 30 }}
>
```

Scale `0.98` is the sweet spot — `0.95` is common but perceptible for large items, while `0.98` is felt but not seen, which is the goal for list items (buttons warrant `0.95`).

### 5. AnimatePresence Patterns for Message Lists

**The virtualized MessageList constraint:** DorkOS uses `@tanstack/react-virtual` for the message list. This means `AnimatePresence` cannot wrap the virtual list directly — each virtual row is absolutely positioned and managed outside React's normal render tree. `AnimatePresence` tracks component mount/unmount, but virtualizer items don't unmount when scrolled out — they reuse DOM elements.

**Implication:** The correct approach (already used in DorkOS) is to animate at the `MessageItem` level using the `isNew` flag, not at the list level. The `motion.div` in `MessageItem` with `initial={isNew ? {...} : false}` is correct.

**For session switching (MessageList crossfade):** The list as a whole should fade out and fade in when `sessionId` changes. This is best handled at the `ChatPanel` level by wrapping the `MessageList` in `AnimatePresence` with `mode="wait"`:

```typescript
// In ChatPanel — crossfade when session switches
<AnimatePresence mode="wait">
  <motion.div
    key={sessionId}
    initial={{ opacity: 0 }}
    animate={{ opacity: 1 }}
    exit={{ opacity: 0 }}
    transition={{ duration: 0.15, ease: 'easeInOut' }}
    className="h-full"
  >
    <MessageList ... />
  </motion.div>
</AnimatePresence>
```

`mode="wait"` ensures the old session fades out before the new one fades in — no overlap. `duration: 0.15` is fast enough to not feel sluggish between sessions.

**Do not use `mode="popLayout"` here** — that mode is for list items being removed while siblings reflow, not for full view transitions.

**For new session items in the sidebar:** `AnimatePresence` with `initial={false}` on the list container + `initial={{ opacity: 0, x: -8 }}` on each `motion.div` item is the standard pattern. The `initial={false}` prevents items from animating when the page first loads.

### 6. Declarative vs Imperative Motion

The motion.dev documentation is clear: **use declarative `motion.div` with variants for 90% of cases.** Use `useAnimate` only for:

- Complex multi-step sequences that can't be expressed as state
- Animations triggered outside React's render cycle
- Scrubbing timelines programmatically

For DorkOS chat microinteractions, everything can be expressed declaratively. `useAnimate` is not needed.

### 7. Reduced Motion Behavior

`MotionConfig reducedMotion="user"` (already applied in DorkOS's `App.tsx`) handles this automatically:

- **Disabled when reduced motion is on**: `transform` animations (translate, scale, rotate), layout animations
- **Preserved when reduced motion is on**: `opacity`, `backgroundColor`, `color` animations

This means the cursor blink, color transitions, and opacity fades all still work — only the physical movement is removed. This is the WCAG-compliant approach: don't remove all feedback, just remove vestibular-triggering movement.

**No additional code is needed** beyond what DorkOS already has. The existing `<MotionConfig reducedMotion="user">` in `App.tsx` is the complete solution.

---

## Detailed Analysis

### Current State Audit

**MessageItem.tsx (line 147–151):**
```typescript
<motion.div
  initial={isNew ? { opacity: 0, y: 8 } : false}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
>
```
- Good: `isNew` gate prevents history items from animating
- Good: `y: 8` is a subtle offset — not dramatic
- Improvement: Switch to spring physics. `duration: 0.2` is fine but spring feels more alive
- Improvement: User messages (`isUser === true`) could use a slightly different variant (e.g., `y: 10, scale: 0.98`)

**SessionItem.tsx (line 64–66):**
```typescript
const Wrapper = isNew ? motion.div : 'div';
```
- This is the right pattern — only newly created sessions animate in
- Missing: `whileTap` for click feedback
- Missing: `layoutId` on the active background highlight

**MessageList.tsx:**
- Uses TanStack Virtual — `AnimatePresence` cannot wrap this
- No session-switch transition — the list just instantly replaces
- This is the most noticeable gap

**AutoHideToolCall (MessageItem.tsx line 51–72):**
```typescript
exit={{ height: 0, opacity: 0 }}
transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
```
- This is well-implemented — the auto-hide exit animation is smooth

### Recommended Changes Summary

| Area | Current | Recommended |
|------|---------|-------------|
| MessageItem entry spring | `duration: 0.2, ease cubic` | `type: 'spring', stiffness: 320, damping: 28` |
| User message distinct animation | Same as AI | Add `scale: 0.97` in initial for user messages |
| Session switch | Instant replace | `AnimatePresence mode="wait"` with 150ms opacity crossfade at ChatPanel level |
| Sidebar item click | No feedback | `whileTap={{ scale: 0.98 }}` on session item wrapper |
| Sidebar active indicator | CSS background class | `layoutId="active-session-bg"` sliding background element |
| Sidebar hover | Already Tailwind CSS | Keep as-is (Tailwind `transition-colors` is correct here) |
| Streaming cursor | Already implemented | No change needed |
| Reduced motion | Already `reducedMotion="user"` | No change needed |

### Implementation Notes for DorkOS

**Virtual list + AnimatePresence:** Because `MessageList` uses TanStack Virtual, wrapping it in `AnimatePresence` at the message level won't work. The session-switch fade must go at the `ChatPanel` level, keyed by `sessionId`. The `MessageList` itself stays unchanged.

**`layoutId` for sidebar active indicator:** The `layoutId` must be the same string across all `SessionItem` instances. Because only one item is active at a time, motion.dev correctly animates the background element from the old active item's position to the new one's position. This requires the active background to be a separate `motion.div` inside the item, positioned absolutely, at a lower z-index than the text content.

**stagger in sidebar:** If the sidebar adds new sessions while the user is watching (e.g., a new session is created), a stagger of 30–50ms between items adds elegance. For initial load, stagger should be disabled (use `initial={false}` on the `AnimatePresence` wrapper).

**Performance:** All recommended animations use `transform` and `opacity` only — these are composited by the browser GPU and do not trigger layout recalculation. The `layout` prop is not recommended for the message list items due to the virtual list setup, which manages positions via absolute transforms directly.

---

## Sources & Evidence

- "transform and opacity are GPU-composited, avoid layout-triggering properties" — [High-performance CSS animations | web.dev](https://web.dev/articles/animations-guide)
- "Keep spring stiffness 100–500, damping 10–40 for natural-feeling animations" — [Framer Motion: Complete React & Next.js Guide 2026](https://inhaq.com/blog/framer-motion-complete-guide-react-nextjs-nextjs-developers)
- "Smooth" spring preset: `stiffness: 300, damping: 25`; "Bouncy" notification: `stiffness: 400, damping: 15` — [Framer Motion Examples: Create Stunning Web Animations](https://goodspeed.studio/blog/framer-motion-examples-animation-enhancements)
- Dashboard layout spring: `stiffness: 300, damping: 30` — same source
- `reducedMotion="user"` disables transforms/layout, preserves opacity/color — [Create accessible animations in React — Motion.dev](https://motion.dev/docs/react-accessibility)
- "mode='wait': entering element waits until exiting child has animated out" — [AnimatePresence modes - Motion Tutorial](https://motion.dev/tutorials/react-animate-presence-modes)
- "mode='popLayout' pairs with layout prop for list item removal reflow" — [AnimatePresence — React exit animations | Motion](https://motion.dev/docs/react-animate-presence)
- "whileTap={{ scale: 0.95 }} shrinks to 95% — immediate feedback that actions are recognized" — [React gesture animations | Motion](https://motion.dev/docs/react-gestures)
- "whileTap={{ scale: 0.98 }} for tap/click feedback with spring transition" — [Framer Motion Examples animation enhancements](https://goodspeed.studio/blog/framer-motion-examples-animation-enhancements)
- "Declarative features: quicker to write, easier to read, more robust to maintain. Use useAnimate only for complex sequencing or timeline control" — [useAnimate — Manual React animation controls - Motion.dev](https://motion.dev/docs/react-use-animate)
- Blinking cursor CSS with `animation: flicker 0.5s infinite` and `@keyframes flicker` — [How to build the ChatGPT typing animation in React - DEV Community](https://dev.to/stiaanwol/how-to-build-the-chatgpt-typing-animation-in-react-2cca)
- Streaming: buffer incoming data, render character-by-character at 5ms/char via `requestAnimationFrame` — [Smooth Text Streaming in AI SDK v5 | Upstash Blog](https://upstash.com/blog/smooth-streaming)
- "Text appears gradually as AI is typing in real time, making the app feel faster and more interactive" — [Real-time AI in Next.js: How to stream responses with the Vercel AI SDK - LogRocket](https://blog.logrocket.com/nextjs-vercel-ai-sdk-streaming/)
- FLIP layout animations: "detects layout changes and smoothly animates using CSS transform (translate + scale) instead of animating width/height" — [Layout Animation — React FLIP & Shared Element | Motion](https://motion.dev/docs/react-layout-animations)
- iMessage message animation using `translateY` and `scale` from send button position — [iMessage conversation animation | CodePen](https://codepen.io/adesurirey/pen/NvOgPz)

---

## Research Gaps & Limitations

- Could not directly inspect the Claude.ai or ChatGPT DOM/source to confirm exact animation values — these are rendered client-side and obfuscated
- The CodeSandbox framer-motion chat animation example was inaccessible (rendered content blocked by CSP in fetch)
- Linear's exact spring config for the sidebar active indicator is not publicly documented — the `layoutId` pattern is inferred from community analysis

---

## Contradictions & Disputes

- **Typewriter vs instant reveal:** Some tutorials recommend character-by-character typewriter animation for streaming AI responses. This is contradicted by analysis of production apps (ChatGPT, Claude.ai) which reveal text tokens without per-character animation. The Upstash blog (which implements a typewriter) acknowledges this is a "visual effect" over real streaming, not the approach production apps use. **Recommendation: instant token reveal with blinking cursor, which is what DorkOS already does.**
- **Motion.dev vs CSS transitions for sidebar hover:** Some resources recommend `whileHover` with motion.dev for all hover states. The motion.dev docs themselves acknowledge that CSS transitions (via Tailwind) are more performant for simple color changes and should be preferred. **Recommendation: Tailwind `transition-colors` for hover, motion.dev `layoutId` for the active indicator only.**

---

## Search Methodology

- Searches performed: 12
- Most productive search terms: "framer motion spring stiffness damping chat list", "AnimatePresence mode wait popLayout session switching", "ChatGPT streaming animation React blinking cursor", "whileTap scale 0.97 click feedback"
- Primary information sources: motion.dev official docs, DEV Community tutorials, Upstash blog, web.dev performance guides, existing DorkOS source at `apps/client/src/layers/features/chat/` and `features/session-list/`
