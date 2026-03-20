---
slug: chat-microinteractions-polish
number: 104
title: Chat Microinteractions & Animation Polish
status: approved
created: 2026-03-09
authors:
  - Claude Code
---

# Chat Microinteractions & Animation Polish

## Status

Approved

## Overview

Polish every microinteraction touchpoint in the DorkOS chat experience. Five targeted changes upgrade the feel from "functional prototype" to "premium tool" without adding visual complexity or harming accessibility. All changes are client-side only and respect `prefers-reduced-motion` automatically via the existing `<MotionConfig reducedMotion="user">` wrapper in `App.tsx`.

## Background / Problem Statement

DorkOS uses `motion` (motion.dev v12) throughout the client, but the chat layer has accumulated inconsistencies:

- **Session switching**: When the user clicks a session in the sidebar, the chat area snaps instantly to the new session — no crossfade, no visual continuity cue.
- **Sidebar active state**: Each session row independently toggles its background color via CSS classes. There is no physical sliding motion between the old and new active row.
- **Message entry**: New messages animate with `transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}` — a CSS-easing duration approach — instead of spring physics, which feels more physical and matches motion.dev's recommended interaction model.
- **User message scale**: Sent user messages appear with only an opacity+translate entrance. They lack the `scale: 0.97 → 1` effect that gives modern messaging apps (iMessage, Telegram) the physical "sent from the input" impression.
- **Tap feedback**: Clicking a session row has no press feedback — no scale or visual confirmation that the row responded to the click.

These are not noticeable individually, but compound into a perception that the UI is unfinished. Power users (personas: Kai Nakamura, the Autonomous Builder) switch sessions and send messages dozens of times per day — polish accumulates.

## Goals

- Add spring physics to all new-message entry animations
- Add `scale: 0.97 → 1` to user message entry (role-gated)
- Add `whileTap={{ scale: 0.98 }}` click feedback to sidebar session rows
- Slide the sidebar active-session background element using `layoutId` (single shared animated element, not N CSS toggles)
- Crossfade between sessions on session switch (opacity fade out → fade in, 150ms each)
- All changes are imperceptible under `prefers-reduced-motion`
- Zero regressions in existing tests

## Non-Goals

- No changes to non-chat panels (Pulse, Relay, Mesh)
- No changes to chat layout or information density
- No per-token streaming animation (researched, rejected: severe jank at high token rates)
- No staggered history message cascade on session switch (researched, rejected: chaos on long sessions with TanStack Virtual)
- No streaming pipeline changes
- No sound, haptic, or other sensory effects
- No CSS Spring token file changes (existing in-component presets are sufficient)

## Technical Dependencies

| Dependency                                              | Version | Already present                                             |
| ------------------------------------------------------- | ------- | ----------------------------------------------------------- |
| `motion` (motion.dev)                                   | v12     | Yes — `package.json`                                        |
| `AnimatePresence`, `motion`, `MotionConfig`, `layoutId` | —       | Yes — used in `App.tsx`, `ChatPanel.tsx`, `SessionItem.tsx` |
| React                                                   | 19      | Yes                                                         |
| Tailwind CSS                                            | v4      | Yes                                                         |

## Detailed Design

### Change 1: Session Switch Crossfade (`App.tsx`)

**Problem**: `<ChatPanel key={activeSessionId} />` causes ChatPanel to unmount/remount on every session switch. The `key` prop lives in `App.tsx` (two render sites: desktop layout ~line 166, mobile layout ~line 218). `AnimatePresence` must be positioned _outside_ the keyed element to observe its mount/unmount lifecycle.

**Solution**: Wrap the `<ChatPanel key={activeSessionId}>` render in both layout variants with `<AnimatePresence mode="wait">` and a `<motion.div key={activeSessionId}>`. The `key` migrates from `<ChatPanel>` to the `<motion.div>` wrapper so ChatPanel does not need changes.

```tsx
// Before (App.tsx desktop layout, ~line 164)
<main className="h-full flex-1 overflow-hidden">
  {activeSessionId ? (
    <ChatPanel
      key={activeSessionId}
      sessionId={activeSessionId}
      transformContent={transformContent}
    />
  ) : (
    <ChatEmptyState ... />
  )}
</main>

// After
<main className="h-full flex-1 overflow-hidden">
  <AnimatePresence mode="wait">
    {activeSessionId ? (
      <motion.div
        key={activeSessionId}
        className="h-full"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15, ease: 'easeInOut' }}
      >
        <ChatPanel
          sessionId={activeSessionId}
          transformContent={transformContent}
        />
      </motion.div>
    ) : (
      <ChatEmptyState ... />
    )}
  </AnimatePresence>
</main>
```

**The same pattern applies to the mobile layout** (`~line 213`). Both sites must be updated.

**Important**: Remove `key={activeSessionId}` from `<ChatPanel>` when adding it to the `<motion.div>` wrapper. ChatPanel itself retains its `sessionId` prop and continues to behave correctly — the remounting is now handled by the motion wrapper's key.

**`mode="wait"`**: Old session fully exits (150ms opacity fade) before new session enters (150ms opacity fade in). Total transition: 300ms. This is appropriate for deliberate navigation actions — the slight pause makes the switch feel intentional, not glitchy.

**Why not `mode="popLayout"` or no mode**: `mode="popLayout"` is designed for sibling list reordering; `mode="sync"` (default) would show both sessions simultaneously, which looks broken.

### Change 2: layoutId Sliding Active Indicator (`SessionItem.tsx`, `SessionSidebar.tsx`)

**Problem**: Each `SessionItem` independently toggles `bg-secondary` via CSS class. There is no cross-item motion when the active session changes.

**Solution**: Replace the CSS `bg-secondary` active background with a shared `motion.div` bearing `layoutId="active-session-bg"`. Motion.dev automatically animates this single DOM element from the old item's position to the new item's position using spring physics.

**SessionItem.tsx changes**:

```tsx
// Remove from className:
isActive ? 'bg-secondary text-foreground ...' : 'hover:bg-secondary/50 ...';

// Add inside the Wrapper div (before all other children, z-index below content):
{
  isActive && (
    <motion.div
      layoutId="active-session-bg"
      className="bg-secondary absolute inset-0 rounded-lg"
      transition={{ type: 'spring', stiffness: 280, damping: 32 }}
    />
  );
}
```

The `Wrapper` div needs `position: relative` (add `relative` to its `className`) and `z-index` context so the absolute `motion.div` sits behind the text content. All existing children need `relative z-10` or equivalent to stay above the sliding background.

**SessionSidebar.tsx changes**:

Add the `layout` prop to the `<SidebarContent>` element (or the nearest scrollable container) to enable motion.dev's layout animation on the session list. Without `layout` on an ancestor, the `layoutId` position calculation may be incorrect when the list scrolls.

```tsx
// In SessionSidebar.tsx
<SidebarContent layout data-testid="session-list">
  ...
</SidebarContent>
```

**Note**: `SidebarContent` is a Shadcn/shadcn-derived component. If it does not forward the `layout` prop, apply `layout` to the `<div>` wrapper inside `SidebarContent` instead, or replace with a `motion(SidebarContent)` HOC.

**Spring preset for sidebar**: `{ type: 'spring', stiffness: 280, damping: 32 }` — smooth and deliberate, avoiding the snappy feel of button interactions.

**Session-group boundaries**: The `layoutId` element crosses `<SidebarGroup>` boundaries because motion.dev measures position relative to the nearest positioned ancestor. Since all groups render in the same `<SidebarContent>`, the sliding background can animate between groups correctly. Test by switching between sessions in different time groups (Today, Yesterday, etc.).

### Change 3: whileTap Feedback on SessionItem (`SessionItem.tsx`)

Add `whileTap={{ scale: 0.98 }}` to the clickable `div[role="button"]` inside `SessionItem`. This must be a `motion.div` — currently the clickable surface is a plain `div`.

```tsx
// Before
<div
  role="button"
  tabIndex={0}
  onClick={...}
  onKeyDown={...}
  className="cursor-pointer px-3 py-2"
>

// After
<motion.div
  role="button"
  tabIndex={0}
  onClick={...}
  onKeyDown={...}
  whileTap={{ scale: 0.98 }}
  transition={{ type: 'spring', stiffness: 400, damping: 30 }}
  className="relative z-10 cursor-pointer px-3 py-2"
>
```

Under `prefers-reduced-motion`, `MotionConfig reducedMotion="user"` collapses `scale` transforms to instant — the tap gesture still registers, but without the scale animation.

### Change 4: Spring Physics + User Message Scale (`MessageItem.tsx`)

**Current** (line 148–150):

```tsx
<motion.div
  initial={isNew ? { opacity: 0, y: 8 } : false}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
```

**Updated**:

```tsx
<motion.div
  initial={isNew ? { opacity: 0, y: 8, scale: isUser ? 0.97 : 1 } : false}
  animate={{ opacity: 1, y: 0, scale: 1 }}
  transition={{ type: 'spring', stiffness: 320, damping: 28 }}
```

Three changes:

1. `scale: isUser ? 0.97 : 1` — role-gated initial scale. Only user messages start compressed. Assistant messages retain the same behavior as before (no scale).
2. `animate={{ ..., scale: 1 }}` — explicit target for the spring to settle at.
3. `transition` upgraded from `{ duration, ease }` to `{ type: 'spring', stiffness: 320, damping: 28 }`. Spring preset: snappy with no bounce.

The `isUser` variable is already computed at line 110: `const isUser = message.role === 'user';`. No new state or props needed.

### Change 5: SessionItem State CSS Transitions (`SessionItem.tsx`)

Audit `SessionItem.tsx` for any text color, opacity, or border state changes that use hard switches (no transition). Add `transition-all duration-150` where state changes are user-perceivable.

The current `className` on `Wrapper` already has `transition-colors duration-150`. After the layoutId refactor removes the `bg-secondary`/`hover:bg-secondary/50` classes, verify:

- The `border-primary`/`border-transparent` left-border transition remains smooth
- The text color change (`text-foreground` on active vs inherited on inactive) is still handled

If the border transition looks jarring after the layoutId change, add `transition-[border-color] duration-150` explicitly.

## Component Hierarchy After Changes

```
App.tsx
└── MotionConfig (reducedMotion="user")                          [unchanged]
    └── AnimatePresence mode="wait" [NEW — wraps ChatPanel]
    │   └── motion.div key={activeSessionId} [NEW — fade wrapper]
    │       └── ChatPanel (no key prop — key migrated to motion.div)
    │           └── MessageList                                   [unchanged]
    │               └── MessageItem × N
    │                   └── motion.div [spring physics + user scale — UPDATED]
    └── SessionSidebar
        └── SidebarContent layout [layout prop — UPDATED]
            └── SessionItem × N
                └── div.relative [position context — UPDATED]
                    ├── motion.div layoutId="active-session-bg" [NEW — conditional on isActive]
                    └── motion.div[role=button] whileTap [NEW — clickable surface]
```

## Spring Preset Reference

| Use case                 | Preset                                            | Character                                    |
| ------------------------ | ------------------------------------------------- | -------------------------------------------- |
| Message entry            | `{ type: 'spring', stiffness: 320, damping: 28 }` | Snappy, no bounce                            |
| Sidebar active indicator | `{ type: 'spring', stiffness: 280, damping: 32 }` | Smooth slide                                 |
| Tap feedback             | `{ type: 'spring', stiffness: 400, damping: 30 }` | Quick, already used for ToolCallCard chevron |
| Session crossfade        | `{ duration: 0.15, ease: 'easeInOut' }`           | Linear opacity — intentional, not spring     |

## User Experience

**Before**: Session click → instant content swap, sidebar background toggles discretely.
**After**: Session click → sidebar background slides (spring) to the new row simultaneously as the chat content fades out and new content fades in.

**Before**: User sends message → message appears from below with eased opacity+translate.
**After**: User sends message → message springs up from a slightly compressed state (`scale: 0.97`), snapping into place — the spring physics create a physical "sent from input" impression.

**Before**: Clicking a session row has no press feedback.
**After**: Session row slightly compresses (`scale: 0.98`) on press, providing kinesthetic confirmation.

## Testing Strategy

### Existing Test Compatibility

The test suite mocks `motion/react` globally (confirmed in test setup). Under the mock, all `motion.*` components render as plain `div` elements and all animation props are ignored. The changes in this spec:

- Add new props (`layoutId`, `whileTap`, `initial`, `animate`, `transition`) to existing `motion.*` components → ignored by mock, tests pass
- Upgrade `Wrapper` pattern in `SessionItem` from conditional `motion.div | 'div'` to always `motion.div` (for the `role="button"` surface) — test mocks render this as a `div`, which matches the current behavior under test

No test infrastructure changes required.

### Unit Tests

**`SessionItem.test.tsx`** — verify:

- Active session renders `data-testid="session-item"` with appropriate accessible state
- The `layoutId` `motion.div` renders when `isActive={true}` and is absent when `isActive={false}`
- `onClick` callback fires when the clickable surface is clicked
- `isNew` entrance animation renders (mock confirms `initial` prop is set)

**`MessageItem.test.tsx`** — verify:

- New user message has `initial` prop containing `scale: 0.97`
- New assistant message has `initial` prop with `scale: 1` (or scale absent)
- History messages have `initial={false}`
- `transition` prop uses spring config (verify `type: 'spring'` is set for `isNew` cases)

**`App.test.tsx` or integration** — verify:

- `AnimatePresence` renders around the session-keyed area
- Switching `activeSessionId` re-renders the motion wrapper with the new key

### Manual Verification Checklist

- [ ] Switch between sessions in Today group → sliding background, fade crossfade
- [ ] Switch between sessions across time groups (Today → Yesterday) → sliding background crosses group boundary correctly
- [ ] Send a user message → spring entry with scale compression
- [ ] Receive an assistant message → spring entry without scale compression
- [ ] Click a session row → visible scale-down tap feedback (scale 0.98)
- [ ] Enable `prefers-reduced-motion` in OS → all interactions work, no transform animations, no jank
- [ ] Open a session with 100+ messages → no cascade animation on history, only new messages animate
- [ ] Rapidly click between sessions → `AnimatePresence mode="wait"` queues transitions correctly, no visual glitching

## Performance Considerations

- **layoutId**: Single DOM element animated between positions via FLIP (First Last Invert Play). Motion.dev handles this at the browser paint layer — CPU cost is minimal. No additional DOM nodes per session item.
- **AnimatePresence**: The old ChatPanel stays mounted for 150ms during exit. This is acceptable — ChatPanel is lightweight at exit time (no active streaming during the transition).
- **Spring physics**: Motion.dev spring animations run on the main thread but delegate to `requestAnimationFrame`. The `stiffness: 320, damping: 28` preset settles in ~250ms with no additional frames after settle. Strictly better than a duration-based animation that could be interrupted mid-way.
- **TanStack Virtual**: `MessageList.tsx` is not modified. The virtualized renderer is unaffected.

## Security Considerations

No security implications. This is a pure client-side animation change with no network I/O, data handling, or state persistence.

## Documentation

- `contributing/animations.md` — update spring preset table to include the three presets used in this spec; add note about `layoutId` shared element pattern.
- `contributing/design-system.md` — update "Message entrance" spec from `200ms ease-out` to `spring stiffness:320 damping:28`; add "Session switch: 150ms opacity crossfade, AnimatePresence mode=wait".

## Implementation Phases

### Phase 1: Core (all 5 changes)

All changes are small and independent. Implement in a single PR in this order (least blast-radius to most):

1. **MessageItem.tsx** — spring physics + user scale (3-line change, zero dependencies)
2. **SessionItem.tsx** — whileTap on clickable surface (wrapper div → motion.div, 1 new prop)
3. **SessionItem.tsx + SessionSidebar.tsx** — layoutId sliding background (~25 lines across 2 files)
4. **App.tsx** — AnimatePresence session crossfade (~15 lines, 2 render sites)
5. Update `contributing/animations.md` and `contributing/design-system.md`

No Phase 2 or Phase 3 — scope is intentionally complete and bounded.

## Open Questions

_All questions resolved during ideation. No open questions._

## Related ADRs

None directly applicable. No existing ADR covers motion.dev animation philosophy or the layoutId shared-element pattern.

## References

- Ideation document: `specs/chat-microinteractions-polish/01-ideation.md`
- Motion.dev AnimatePresence docs: https://motion.dev/docs/react-animate-presence
- Motion.dev layoutId docs: https://motion.dev/docs/react-layout-animations
- `contributing/animations.md` — existing motion patterns in DorkOS
- `contributing/design-system.md` — Calm Tech motion spec
