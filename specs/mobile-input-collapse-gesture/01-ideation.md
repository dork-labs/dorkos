---
slug: mobile-input-collapse-gesture
number: 22
created: 2026-02-13
status: implemented
---

# Mobile Input Area Collapse Gesture

**Slug:** mobile-input-collapse-gesture
**Author:** Claude Code
**Date:** 2026-02-13
**Related:** N/A

---

## 1) Intent & Assumptions

**Task brief:** The bottom input area (textarea + shortcut chips + status bar) takes too much vertical space on mobile. Add swipe-down-to-collapse and swipe-up-to-expand gestures that hide/show the chips and status bar. Only on mobile. Find a UX approach that makes the gesture discoverable without adding visual clutter.

**Assumptions:**

- The textarea itself always remains visible — only chips and status bar collapse
- "Mobile" = screens below 768px (matches existing `useIsMobile` hook / `MOBILE_BREAKPOINT`)
- On desktop, chips and status bar always show (no gesture, no change)
- Collapsed/expanded state does not need to persist across sessions (reset on load)
- The existing `showShortcutChips` setting in app-store remains independent — if a user disables chips in settings, they stay hidden regardless of gesture state

**Out of scope:**

- Collapsing the textarea itself
- Desktop gesture support
- Auto-collapse based on typing or streaming state (research shows Discord users dislike this)
- Swipe-to-dismiss the entire input area

---

## 2) Pre-reading Log

- `apps/client/src/components/chat/ChatPanel.tsx` (lines 392-438): The `chat-input-container` div holds `CommandPalette`/`FilePalette` (above input), `ChatInput`, `ShortcutChips` (conditional on `showShortcutChips` store), and `StatusLine`. This is the target area.
- `apps/client/src/components/chat/ShortcutChips.tsx`: Small component, already wrapped in `AnimatePresence` in ChatPanel. Uses `motion.div` with fade animation.
- `apps/client/src/components/status/StatusLine.tsx`: Status bar component showing cwd, permission mode, model, cost, context, git info.
- `apps/client/src/stores/app-store.ts`: Zustand store with `showShortcutChips` toggle. Already persists to localStorage. Could add `mobileInputCollapsed` state here.
- `apps/client/src/hooks/use-is-mobile.ts`: Returns boolean for `< 768px`. Used in `App.tsx` for sidebar overlay logic.
- `apps/client/src/App.tsx`: Already imports `motion`, `AnimatePresence`, `MotionConfig` from `motion/react`. `MotionConfig reducedMotion="user"` wraps the app.
- `guides/design-system.md`: Animation durations 100-300ms, uses motion.dev springs.

---

## 3) Codebase Map

**Primary components that need changes:**

- `apps/client/src/components/chat/ChatPanel.tsx` — Wrap chips + status bar in a collapsible container with gesture handling
- `apps/client/src/stores/app-store.ts` — Add `mobileInputCollapsed` state (optional, could be local state)

**Shared dependencies:**

- `motion/react` — Already in the dependency tree (motion.dev). Used extensively throughout the app for animations.
- `useIsMobile()` hook — Already exists, returns boolean for `< 768px`
- `useAppStore` — Zustand store, already has `showShortcutChips`

**Data flow:**
Swipe gesture on `chat-input-container` → update `collapsed` state → `AnimatePresence` hides/shows chips + status bar with spring animation

**Potential blast radius:**

- Direct: `ChatPanel.tsx` (gesture wrapper + conditional rendering)
- Possibly: `app-store.ts` (if persisting collapsed state)
- Tests: `ChatPanel.test.tsx`, `ShortcutChips.test.tsx` may need updates if DOM structure changes
- No server changes needed

---

## 4) Root Cause Analysis

N/A — This is a feature, not a bug fix.

---

## 5) Research

### Gesture Library: motion.dev built-in drag (Recommended)

The app already depends on `motion/react`. Motion provides `drag="y"`, `dragConstraints`, `dragElastic`, and `onDragEnd` with velocity/offset data — everything needed for swipe detection. Zero additional bundle cost.

Alternatives considered:

- **@use-gesture/react** — More granular control but adds ~20-30KB bundle, requires integration work with motion.dev for animations. Overkill for this use case.
- **Native touch events** — Zero bundle but requires manual velocity calculation, threshold logic, and animation coordination. More code to maintain.
- **Hammer.js / TinyGesture** — Not React-native, less maintained, requires wrappers.

### Animation Strategy

**Use `AnimatePresence` + height animation via motion.dev `layout` prop** rather than `scaleY` transform. While `scaleY` is more performant in theory (GPU-composited), it visually distorts text and child elements. Motion's layout animations use the FLIP technique to animate height changes performantly.

**Spring animations** for the collapse/expand — they incorporate gesture velocity for natural feel. Recommended: `stiffness: 300, damping: 30`.

### Discoverability UX (Critical)

Research consensus: **gestures alone have poor discoverability**. Even Tinder teaches its swipe gesture to first-time users.

**Recommended multi-layer approach:**

1. **Drag handle (persistent, minimal):** A small horizontal pill/bar (36px wide, 4px tall, centered) between the textarea and the chips. This is the Material Design pattern — users recognize it from bottom sheets in every major app. On mobile only. Doubles as a visual separator. Subtle enough to not add clutter, but universally recognized as "draggable."

2. **First-use animated hint (one-time):** On first mobile visit, briefly animate the drag handle downward with a small text label "Swipe to collapse" that fades away after 3-4 seconds. Stored in localStorage so it only shows once.

3. **Elastic feedback during gesture:** As the user drags, the chips/status bar should follow the finger with elastic resistance, giving immediate visual feedback that something is happening. This teaches the gesture through interaction.

4. **State indicator:** When collapsed, the drag handle gets a subtle upward chevron (or rotates). When expanded, no chevron (default state). This is minimal but communicates that expansion is possible.

### Browser Conflict Prevention

- CSS `overscroll-behavior-y: contain` on the input container prevents pull-to-refresh interference
- `touch-action: pan-y` on the gesture target tells the browser to let vertical panning through but allows our gesture handler to intercept
- React 17+ makes touch listeners passive by default — fine for this case since we use motion.dev's drag system which handles this internally

### Key UX Principles from Research

- **Never auto-collapse** — Discord users complained about input area resizing without their control
- **Multi-modal interaction** — Gesture + tappable handle, not gesture-only (accessibility)
- **Don't block typing** — The gesture should only activate on the drag handle / border area between textarea and chips, NOT on the textarea itself (would conflict with text selection and scrolling within the textarea)

---

## 6) Decisions

1. **Gesture target area:** Below textarea only (drag handle + chips + status bar). Avoids conflicts with text selection/scrolling in the textarea.
2. **Drag handle visual:** Yes — small horizontal pill (Material Design pattern) between textarea and chips. ~12px total height with padding.
3. **Persistence:** Reset on reload. Always start expanded so users see the full UI each session.
4. **First-use hint:** Animated hint on first 3 mobile visits. Bouncing handle + "Swipe to collapse" label for 3-4s, auto-dismiss. Track visit count in localStorage.
5. **Tap-to-toggle:** Yes — tapping the drag handle toggles collapse/expand. Button role with aria-label for accessibility.
