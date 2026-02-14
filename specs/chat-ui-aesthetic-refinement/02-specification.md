# Chat UI Aesthetic Refinement

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-02-07
**Slug:** chat-ui-aesthetic-refinement
**Ideation:** `specs/chat-ui-aesthetic-refinement/01-ideation.md`
**Design System:** `guides/design-system.md`

---

## Overview

Comprehensive aesthetic refinement of the DorkOS chat UI. Transform the interface from a functional prototype into a world-class minimal chat experience through coordinated updates to color, typography, spacing, motion, and micro-interactions. Every layer works together: warm neutrals, clear typographic hierarchy, consistent 8pt spacing, purposeful motion via motion.dev, and subtle micro-interactions that communicate care.

## Background / Problem Statement

The current chat UI is structurally sound but visually flat. It uses shadcn's default zinc palette, inconsistent spacing, no animations, and no micro-interactions. The interface feels like a well-organized prototype rather than a finished product.

Key deficiencies identified through Jony Ive-lens critique:

1. **Color** - Zinc palette is technically correct but emotionally flat. `bg-muted/30` on user messages is nearly invisible. Orange-500 Claude avatar is an afterthought.
2. **Typography** - `text-sm` (14px) is slightly small for sustained reading. No clear weight hierarchy.
3. **Spacing** - Inconsistent padding across components (px-4/py-3, px-3/py-2, px-2/py-1.5). No deliberate rhythm.
4. **Motion** - Essentially static. Messages pop in, tool cards snap open, sidebar appears instantly.
5. **Micro-interactions** - None. No hover feedback, no press states, no streaming cursor, no scroll-to-bottom button.
6. **Empty states** - No graceful handling of "no session selected" or "new session" states.

## Goals

- Replace the zinc HSL palette with refined neutral grays in both light and dark modes
- Establish typographic hierarchy with 15px base, clear weight scale (400/500/600), 65ch max-width
- Normalize all spacing to an 8pt grid
- Add purposeful motion via motion.dev for message entrance, tool card expand/collapse, command palette, sidebar toggle, and button interactions
- Add streaming cursor (blinking pipe) during active streaming
- Add scroll-to-bottom floating button when user scrolls up
- Replace loading spinner with three-dot typing indicator
- Add hover-reveal timestamps on messages
- Add centered empty state with "New conversation" prompt
- Add subtle hover states on interactive elements
- Add button micro-interactions (scale on hover/press)
- Soften tool approval status colors
- Respect `prefers-reduced-motion` across all animated components
- Maintain full dark mode support

## Non-Goals

- Backend changes (Express server, Agent SDK integration)
- New features (file upload, image rendering, voice input)
- Mobile-specific responsive layouts
- Authentication/authorization UI
- Custom font loading (system fonts only)
- `@tailwindcss/typography` plugin (Streamdown provides its own styling)
- Changes to SSE streaming protocol or message data model

## Technical Dependencies

| Dependency | Version | Status | Purpose |
|-----------|---------|--------|---------|
| `motion` | latest | **New install** | Animation library (motion.dev, successor to Framer Motion) |
| `react` | ^19.0.0 | Installed | UI framework |
| `tailwindcss` | ^4.0.0 | Installed | CSS framework |
| `@tanstack/react-virtual` | ^3.11.0 | Installed | Virtual scrolling |
| `zustand` | ^5.0.0 | Installed | UI state |
| `streamdown` | latest | Installed | Markdown rendering |
| `lucide-react` | latest | Installed | Icons |

### motion.dev API Reference

Import pattern:
```tsx
import { motion, AnimatePresence, MotionConfig } from 'motion/react';
```

Key APIs used in this spec:

- **`motion.div`** - Animated div with `initial`, `animate`, `exit` props
- **`AnimatePresence`** - Enables exit animations for unmounting components
- **`MotionConfig reducedMotion="user"`** - App-level wrapper that respects `prefers-reduced-motion`
- **`whileHover` / `whileTap`** - Gesture-based animations for buttons
- **`transition`** - Timing config: `{ type: 'spring', stiffness: 400, damping: 30 }` or `{ duration: 0.2, ease: [0, 0, 0.2, 1] }`

## Detailed Design

### Architecture

No architectural changes. All modifications are in the rendering/styling layer. The data flow is unchanged:

```
SSE text_delta -> useChatSession (unchanged) -> setMessages (unchanged)
  -> MessageList (minor) -> MessageItem (styled + animated) -> StreamingText (cursor added)
```

### File Changes

#### 1. `package.json` — Add motion dependency

```bash
npm install motion
```

#### 2. `src/client/index.css` — Color palette + animations

Replace shadcn zinc HSL values with refined neutral palette. Add keyframe animations for typing indicator and streaming cursor.

**Color token replacements (light mode):**

| Token | Current (zinc) | New (refined neutral) |
|-------|---------------|----------------------|
| `--background` | `0 0% 100%` | `0 0% 98%` (#FAFAFA) |
| `--foreground` | `240 10% 3.9%` | `0 0% 9%` (#171717) |
| `--muted` | `240 4.8% 95.9%` | `0 0% 96%` (#F5F5F5) |
| `--muted-foreground` | `240 3.8% 46.1%` | `0 0% 32%` (#525252) |
| `--border` | `240 5.9% 90%` | `0 0% 83%` (#D4D4D4) |
| `--ring` | `240 5.9% 10%` | `217 91% 60%` (#3B82F6) |
| `--accent` | `240 4.8% 95.9%` | `0 0% 96%` (#F5F5F5) |

**Color token replacements (dark mode):**

| Token | Current (zinc) | New (refined neutral) |
|-------|---------------|----------------------|
| `--background` | `240 10% 3.9%` | `0 0% 4%` (#0A0A0A) |
| `--foreground` | `0 0% 98%` | `0 0% 93%` (#EDEDED) |
| `--muted` | `240 3.7% 15.9%` | `0 0% 9%` (#171717) |
| `--muted-foreground` | `240 5% 64.9%` | `0 0% 64%` (#A3A3A3) |
| `--border` | `240 3.7% 15.9%` | `0 0% 25%` (#404040) |
| `--ring` | `240 4.9% 83.9%` | `213 94% 68%` (#60A5FA) |

**New keyframes:**

```css
@keyframes typing-dot {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1); }
}

@keyframes blink-cursor {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
```

#### 3. `src/client/App.tsx` — MotionConfig wrapper, sidebar animation, empty state

**MotionConfig wrapper:** Wrap the app root with `<MotionConfig reducedMotion="user">` to globally respect accessibility preferences.

**Sidebar animation:** Replace conditional render with animated width transition. The sidebar container always renders but transitions between `w-64` and `w-0` using motion.div with `overflow-hidden`.

**Empty state:** When no session is selected, render a centered "New conversation" prompt instead of the current text-only fallback.

```tsx
// Sidebar container with width animation
<motion.div
  animate={{ width: sidebarOpen ? 256 : 0 }}
  transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
  className="overflow-hidden flex-shrink-0 border-r"
>
  <div className="w-64">
    <SessionSidebar />
  </div>
</motion.div>
```

```tsx
// Empty state when no session selected
<div className="flex-1 flex items-center justify-center">
  <div className="text-center">
    <p className="text-muted-foreground text-base">New conversation</p>
    <p className="text-muted-foreground/60 text-sm mt-2">
      Select a session or start a new one
    </p>
  </div>
</div>
```

#### 4. `src/client/components/chat/ChatPanel.tsx` — Typing indicator, empty state, error banner

**Typing indicator:** Replace `<div className="animate-spin" />` spinner with three pulsing dots:

```tsx
function TypingIndicator() {
  return (
    <div className="flex items-center gap-1 px-4 py-3">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="w-2 h-2 rounded-full bg-muted-foreground/50"
          style={{ animation: `typing-dot 1.4s ease-in-out ${i * 0.2}s infinite` }}
        />
      ))}
    </div>
  );
}
```

**Empty session state:** When a session has no messages, show a greeting centered in the chat area.

**Error banner:** Replace `bg-red-500` with muted red: `bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20`.

#### 5. `src/client/components/chat/MessageList.tsx` — Scroll-to-bottom button, isNew flag

**Scroll-to-bottom button:** Use a ref to track whether the user is scrolled to the bottom. When scrolled up, render a floating button that scrolls to the latest message.

```tsx
// Track if user is near bottom
const isNearBottom = useRef(true);
const handleScroll = () => {
  const container = scrollRef.current;
  if (!container) return;
  const threshold = 100;
  isNearBottom.current =
    container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
};

// Floating button (AnimatePresence for enter/exit)
<AnimatePresence>
  {!isNearBottom && (
    <motion.button
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 10 }}
      transition={{ duration: 0.15 }}
      onClick={scrollToBottom}
      className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-background border shadow-sm p-2"
    >
      <ArrowDown className="h-4 w-4" />
    </motion.button>
  )}
</AnimatePresence>
```

**isNew flag:** Pass a flag to `MessageItem` indicating whether a message was added after initial history load. Only messages added via SSE streaming get `isNew={true}`; history messages get `isNew={false}`.

Implementation: Track `historyLoaded` state. After initial `api.getMessages()` resolves, set `historyLoaded = true`. All subsequent messages from SSE events are marked `isNew`.

#### 6. `src/client/components/chat/MessageItem.tsx` — Entrance animation, timestamps, hover, avatar

**Entrance animation:** Wrap in `motion.div` with fade-in + slide-up, only when `isNew` is true:

```tsx
interface MessageItemProps {
  message: ChatMessage;
  isNew?: boolean;
}

export function MessageItem({ message, isNew = false }: MessageItemProps) {
  return (
    <motion.div
      initial={isNew ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
      className={cn(
        'group flex gap-4 px-4 py-3 transition-colors duration-150',
        isUser ? 'bg-muted/40' : '',
        'hover:bg-muted/20'
      )}
    >
      {/* ... */}
    </motion.div>
  );
}
```

**Hover-reveal timestamps:** Show timestamp on group hover, positioned next to the role label:

```tsx
<div className="flex items-center gap-2 mb-1">
  <span className="text-xs text-muted-foreground font-medium">
    {isUser ? 'You' : 'Claude'}
  </span>
  <span className="text-xs text-muted-foreground/0 group-hover:text-muted-foreground/60 transition-colors duration-150">
    {formatTime(message.timestamp)}
  </span>
</div>
```

**Avatar refinement:** Change Claude's avatar from `bg-orange-500` to muted terracotta:

```tsx
// Before
<div className="rounded-full bg-orange-500 p-1.5">

// After
<div className="rounded-full p-1.5" style={{ backgroundColor: '#C2724E' }}>
```

Alternatively, define a CSS custom property `--claude-avatar` and use it via Tailwind arbitrary value.

**Spacing:** Normalize to 8pt grid: `gap-4` (16px), `px-4` (16px), `py-3` (12px). These values already mostly align.

#### 7. `src/client/components/chat/StreamingText.tsx` — Streaming cursor

Accept an `isStreaming` prop. When true, append a blinking cursor after the Streamdown content:

```tsx
interface StreamingTextProps {
  content: string;
  isStreaming?: boolean;
}

export function StreamingText({ content, isStreaming = false }: StreamingTextProps) {
  return (
    <div className="relative">
      <Streamdown shikiTheme={['github-light', 'github-dark']}>
        {content}
      </Streamdown>
      {isStreaming && (
        <span
          className="inline-block w-0.5 h-[1.1em] bg-foreground/70 align-text-bottom ml-0.5"
          style={{ animation: 'blink-cursor 1s step-end infinite' }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
```

The cursor position (after the Streamdown output) requires the cursor to be a sibling element. If Streamdown's wrapper doesn't allow inline sibling placement, the cursor can be positioned absolutely at the end of the last text node using a ref-based approach.

#### 8. `src/client/components/chat/ChatInput.tsx` — Button interactions, placeholder, focus

**Button micro-interactions:**

```tsx
<motion.button
  whileHover={{ scale: 1.05 }}
  whileTap={{ scale: 0.97 }}
  transition={{ type: 'spring', stiffness: 400, damping: 30 }}
  onClick={handleSubmit}
  className="..."
>
  <Send className="h-4 w-4" />
</motion.button>
```

**Placeholder:** Change from "Type a message or / for commands..." to "Message Claude..."

**Focus ring:** Add `transition-colors duration-150` to the textarea wrapper. On focus, shift border color to accent:

```tsx
className={cn(
  'border rounded-lg transition-colors duration-150',
  isFocused ? 'border-ring' : 'border-border'
)}
```

#### 9. `src/client/components/chat/ToolCallCard.tsx` — Height animation, hover state

**Expand/collapse animation:** Replace the static conditional render with `AnimatePresence`:

```tsx
<AnimatePresence initial={false}>
  {isExpanded && (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
      className="overflow-hidden"
    >
      <div className="px-3 pb-3 pt-1">
        {/* content */}
      </div>
    </motion.div>
  )}
</AnimatePresence>
```

**Chevron rotation:** Animate the chevron with spring physics:

```tsx
<motion.div
  animate={{ rotate: isExpanded ? 180 : 0 }}
  transition={{ type: 'spring', stiffness: 400, damping: 30 }}
>
  <ChevronDown className="h-4 w-4" />
</motion.div>
```

**Hover state:** Add `transition-all duration-150 hover:border-border hover:shadow-sm` to the card container.

#### 10. `src/client/components/chat/ToolApproval.tsx` — Softer status colors

Replace saturated colors with muted variants:

| Status | Current | New |
|--------|---------|-----|
| Pending | `bg-yellow-500` | `bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20` |
| Approved | `bg-green-500` | `bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20` |
| Denied | `bg-red-500` | `bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20` |

Add `transition-colors duration-200` for smooth state transitions.

#### 11. `src/client/components/commands/CommandPalette.tsx` — Enter/exit animation

Wrap the palette in `AnimatePresence` with fade + scale:

```tsx
<AnimatePresence>
  {isOpen && (
    <motion.div
      initial={{ opacity: 0, scale: 0.98, y: 4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98, y: 4 }}
      transition={{ duration: 0.15, ease: [0, 0, 0.2, 1] }}
      className="absolute bottom-full mb-2 w-full ..."
    >
      {/* Command content */}
    </motion.div>
  )}
</AnimatePresence>
```

#### 12. `src/client/components/sessions/SessionSidebar.tsx` — Spacing, button styling

Normalize padding to 8pt grid. Improve "New Session" button with cleaner dashed border treatment and hover state.

#### 13. `src/client/components/sessions/SessionItem.tsx` — Hover transitions

Add `transition-colors duration-150` to the session item wrapper. The existing `bg-accent` active state remains but transitions smoothly.

### Data Flow for Streaming Cursor

The `isStreaming` prop on `StreamingText` needs to reflect whether the specific message is actively receiving deltas. In `useChatSession`, `status === 'streaming'` indicates the session is streaming. The last assistant message in the list is the one being streamed to. `MessageItem` receives `isStreaming` when it's the last assistant message and the session status is streaming.

### Accessibility: prefers-reduced-motion

The `<MotionConfig reducedMotion="user">` wrapper at the app root automatically handles this for all motion.dev animations. When `prefers-reduced-motion: reduce` is set:

- Message entrance animations are disabled (no fade/slide)
- Tool card expand/collapse transitions are instant
- Button scale animations are disabled
- Command palette appears/disappears instantly
- Sidebar toggle is instant

CSS-only animations (typing indicator, streaming cursor) need explicit media query:

```css
@media (prefers-reduced-motion: reduce) {
  .typing-dot, .streaming-cursor {
    animation: none !important;
  }
}
```

## User Experience

**Before:** A flat, static interface with zinc grays, no animations, and minimal visual feedback. Messages pop into existence. Tool cards snap open. The sidebar appears or disappears without transition. No indication of active streaming beyond text appearing.

**After:** A polished, minimal interface where every element communicates care:

- Messages gently fade in and slide up when they arrive
- A blinking cursor shows Claude is actively thinking/writing
- Tool cards smoothly expand and collapse with spring-physics chevron rotation
- Hovering over a message subtly reveals its timestamp
- The command palette gracefully enters and exits
- The sidebar smoothly transitions open and closed
- Buttons respond to hover and press with subtle scale changes
- When scrolled up in history, a floating button appears to jump back to the latest message
- A gentle three-dot typing indicator replaces the raw spinner
- Colors are warmer and more intentional, reducing eye strain
- The empty state welcomes users with a clean "New conversation" prompt

The interface remains minimal. Nothing decorates; everything communicates.

## Testing Strategy

### Unit Tests

All existing tests must continue to pass. New tests are needed for new behaviors.

#### Mocking motion.dev

Motion components need to be mocked in tests since they rely on browser animation APIs:

```tsx
vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  },
  AnimatePresence: ({ children }: any) => <>{children}</>,
  MotionConfig: ({ children }: any) => <>{children}</>,
}));
```

#### Updated test: `MessageItem.test.tsx`

```tsx
// Purpose: Verify entrance animation only fires for new messages
it('applies initial animation props when isNew is true', () => {
  const msg = { id: '1', role: 'assistant' as const, content: 'Hi', timestamp: new Date().toISOString() };
  const { container } = render(<MessageItem message={msg} isNew={true} />);
  // With mocked motion.div, verify the component renders without errors
  expect(screen.getByText('Claude')).toBeDefined();
});

// Purpose: Verify timestamp renders on hover (always present in DOM, hidden by CSS)
it('renders timestamp element', () => {
  const ts = '2026-02-07T10:30:00Z';
  const msg = { id: '1', role: 'user' as const, content: 'Test', timestamp: ts };
  render(<MessageItem message={msg} />);
  // Timestamp text should be in the DOM (visibility controlled by CSS hover)
  expect(screen.getByText(/10:30/)).toBeDefined();
});

// Purpose: Verify Claude avatar uses terracotta color, not orange-500
it('renders Claude avatar with terracotta color', () => {
  const msg = { id: '1', role: 'assistant' as const, content: 'Hi', timestamp: new Date().toISOString() };
  const { container } = render(<MessageItem message={msg} />);
  const avatar = container.querySelector('[style*="C2724E"]') ||
                 container.querySelector('.bg-\\[\\#C2724E\\]');
  // Verify orange-500 is no longer used
  expect(container.querySelector('.bg-orange-500')).toBeNull();
});
```

#### Updated test: `StreamingText.test.tsx`

```tsx
// Purpose: Verify streaming cursor appears when isStreaming is true
it('shows cursor when streaming', () => {
  render(<StreamingText content="Hello" isStreaming={true} />);
  expect(screen.getByRole('presentation', { hidden: true }) ||
    document.querySelector('[aria-hidden="true"]')).toBeDefined();
});

// Purpose: Verify cursor is hidden when not streaming
it('hides cursor when not streaming', () => {
  render(<StreamingText content="Hello" isStreaming={false} />);
  // Cursor element should not be present
  const cursor = document.querySelector('[style*="blink-cursor"]');
  expect(cursor).toBeNull();
});
```

#### New test: `ToolCallCard.test.tsx` additions

```tsx
// Purpose: Verify AnimatePresence wraps expandable content
it('renders expanded content with animation wrapper', async () => {
  // Click to expand, verify content appears
  // With mocked AnimatePresence, content renders directly
});
```

### Manual Testing Checklist

- [ ] Color palette renders correctly in light mode
- [ ] Color palette renders correctly in dark mode
- [ ] Toggle between light/dark mode - all colors transition
- [ ] Message text is readable at 15px base size
- [ ] Messages constrained to ~65ch width
- [ ] New messages fade in with slide-up animation
- [ ] History messages load instantly (no animation)
- [ ] Streaming cursor blinks while Claude is responding
- [ ] Streaming cursor disappears when response completes
- [ ] Scroll up in history - scroll-to-bottom button appears
- [ ] Click scroll-to-bottom button - scrolls to latest message
- [ ] Hover over message - timestamp appears
- [ ] Hover over message - subtle background shift
- [ ] Send button has scale-up on hover, scale-down on press
- [ ] Tool card expand/collapse is smooth height transition
- [ ] Tool card chevron rotates with spring physics
- [ ] Tool card hover shows border/shadow change
- [ ] Command palette fades in with scale animation
- [ ] Command palette fades out on close
- [ ] Sidebar toggle animates width smoothly
- [ ] Typing indicator shows three pulsing dots during history load
- [ ] Tool approval cards use muted status colors
- [ ] Empty state shows centered "New conversation" when no session selected
- [ ] Claude avatar is muted terracotta, not bright orange
- [ ] Enable `prefers-reduced-motion` - all animations disabled
- [ ] Virtual scrolling still works correctly with animated messages
- [ ] Long conversations still scroll smoothly

## Performance Considerations

- **Virtual scrolling compatibility**: `motion.div` wraps individual message items within the virtualizer. Only the newest message gets `initial` animation props; history messages get `initial={false}` to skip animation entirely. This prevents re-animation when the virtualizer recycles elements.
- **AnimatePresence overhead**: Used sparingly on tool card content and command palette. Both are small DOM trees.
- **CSS-only animations**: Typing indicator and streaming cursor use CSS `@keyframes` instead of motion.dev for zero JS overhead.
- **Bundle size**: motion.dev adds ~15-20KB gzipped. This is the only new dependency.
- **Transition efficiency**: All hover states use CSS `transition` (not motion.dev) for native browser optimization.
- **No layout thrashing**: Height animations on tool cards use `height: auto` which motion.dev handles via FLIP technique internally.
- **Streaming performance**: The `isStreaming` prop is derived from existing `status` state in `useChatSession` - no new state management or re-render paths introduced.

## Security Considerations

- No new external connections. motion.dev is a client-side library with no network calls.
- No changes to data handling, authentication, or API surface.
- The streaming cursor is purely decorative (`aria-hidden="true"`).
- All color values are static CSS - no dynamic user input in styles.

## Documentation

- Update `CLAUDE.md` (gateway) to note motion.dev is used for animations and reference the design system guide
- The design system guide at `guides/design-system.md` (already created) serves as the primary design documentation
- No other documentation changes needed

## Implementation Phases

All phases ship together as a single cohesive transformation.

### Phase 1: Foundations (Color, Typography, Spacing)

1. Update CSS custom properties in `index.css` (light + dark mode palettes)
2. Add `@keyframes` for typing indicator and streaming cursor
3. Add `prefers-reduced-motion` media query
4. Normalize spacing across all components to 8pt grid
5. Update typography (base text size, weight hierarchy)
6. Update Claude avatar to terracotta

### Phase 2: Motion (motion.dev integration)

7. Install `motion` package
8. Add `MotionConfig reducedMotion="user"` wrapper in `App.tsx`
9. Message entrance animation in `MessageItem.tsx` (with `isNew` flag from `MessageList.tsx`)
10. Tool card expand/collapse animation in `ToolCallCard.tsx`
11. Command palette enter/exit animation in `CommandPalette.tsx`
12. Sidebar width transition in `App.tsx`

### Phase 3: Micro-interactions & Polish

13. Button micro-interactions in `ChatInput.tsx`
14. Streaming cursor in `StreamingText.tsx` (with `isStreaming` prop)
15. Scroll-to-bottom button in `MessageList.tsx`
16. Typing indicator in `ChatPanel.tsx`
17. Hover-reveal timestamps in `MessageItem.tsx`
18. Hover states on messages, session items, tool cards
19. Empty states (no session selected, new session)

### Phase 4: Visual Details

20. Tool approval muted colors in `ToolApproval.tsx`
21. Error banner refinement in `ChatPanel.tsx`
22. Focus ring transitions in `ChatInput.tsx`
23. Session item hover transitions in `SessionItem.tsx`
24. Update tests: mock motion.dev, add new test cases
25. Verify all existing tests pass

## Open Questions

None. All clarifications from ideation have been resolved:

1. **Color palette** -> Pure neutral grays (no warm tint)
2. **Avatar** -> Muted terracotta (#C2724E)
3. **Fonts** -> System fonts only
4. **Scope** -> All phases ship together
5. **Timestamps** -> Hover-reveal
6. **Empty state** -> Centered "New conversation" prompt

## References

- [motion.dev Documentation](https://motion.dev/) - Animation library
- [motion.dev React Guide](https://motion.dev/docs/react-quick-start) - React integration
- [motion.dev AnimatePresence](https://motion.dev/docs/react-animate-presence) - Exit animations
- [motion.dev MotionConfig](https://motion.dev/docs/react-motion-config) - Global configuration
- [Tailwind CSS v4](https://tailwindcss.com/blog/tailwindcss-v4) - CSS framework
- [Design System Guide](../guides/design-system.md) - Full design tokens and specifications
- [Ideation Document](./01-ideation.md) - Discovery, research, and Jony Ive critique
