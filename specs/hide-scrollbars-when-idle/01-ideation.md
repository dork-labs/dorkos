---
slug: hide-scrollbars-when-idle
number: 114
created: 2026-03-10
status: ideation
---

# Hide Scrollbars When Idle

**Slug:** hide-scrollbars-when-idle
**Author:** Claude Code
**Date:** 2026-03-10
**Branch:** preflight/hide-scrollbars-when-idle

---

## 1) Intent & Assumptions

- **Task brief:** Scrollbar handles in the SessionSidebar and ChatPanel's MessageList are always visible, even on macOS Chrome where they should auto-hide by default. The user wants scrollbar handles hidden when not actively scrolling — they should auto-appear during scroll activity and fade out after ~800ms of inactivity, matching macOS-native behavior.

- **Assumptions:**
  - The root cause is the global `::-webkit-scrollbar` styling in `index.css` which forces scrollbar visibility by defining a non-zero width
  - Mobile scrollbar hiding (already implemented via media query) should be preserved
  - The command palette's existing opacity-fade scrollbar pattern is the reference implementation
  - No new npm dependencies — pure CSS + JS approach using existing event listeners
  - The TanStack Virtual message list needs special handling since it can't use shadcn ScrollArea

- **Out of scope:**
  - Replacing the scroll container architecture (ScrollArea vs native div)
  - Changing the TanStack Virtual configuration
  - Custom scrollbar theming/colors (keep existing `bg-border` token)
  - Horizontal scrollbar handling (only vertical scrollbars are the issue)

## 2) Pre-reading Log

- `apps/client/src/index.css`: Global scrollbar styles with `::-webkit-scrollbar` (6px width, `bg-border` thumb). Mobile hides scrollbars entirely. Command palette has opacity-fade pattern via `[cmdk-list]` selectors.
- `apps/client/src/layers/shared/ui/scroll-area.tsx`: Radix ScrollArea wrapper with `data-slot="scroll-area-scrollbar"`. Has `transition-colors` on scrollbar, `bg-border` on thumb.
- `apps/client/src/layers/features/chat/ui/MessageList.tsx`: Virtual message list using native `<div ref={parentRef} className="chat-scroll-area h-full overflow-y-auto pt-12">` — NOT wrapped in ScrollArea. Uses `useVirtualizer` from `@tanstack/react-virtual`.
- `apps/client/src/layers/features/chat/model/use-scroll-overlay.ts`: Scroll state management — tracks `isAtBottom`, `isUserScrolling`, has wheel/touchstart listeners with debounced intent detection (ADR-0092).
- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`: Uses shadcn `SidebarContent` which provides native overflow scrolling.
- `apps/client/src/layers/shared/ui/sidebar.tsx`: `SidebarContent` renders with `overflow-auto` class.
- `apps/client/src/layers/features/command-palette/ui/CommandPaletteDialog.tsx`: Uses `<ScrollArea>` wrapper around `<CommandList>`. Already has idle-scrollbar hiding via opacity CSS.
- `contributing/design-system.md`: Calm Tech design philosophy. Animation timing: 150ms ease-out for appearance, 200ms ease-in for disappearance.
- `contributing/animations.md`: Motion library patterns, spring physics, transition durations.
- `decisions/0092-user-scroll-intent-via-wheel-touchstart.md`: Scroll intent detection via wheel/touchstart events — existing pattern to build on.

## 3) Codebase Map

- **Primary components/modules:**
  - `apps/client/src/index.css` — Global scrollbar styling (root cause)
  - `apps/client/src/layers/features/chat/ui/MessageList.tsx` — Virtual message list with native scroll container
  - `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx` — Session sidebar list
  - `apps/client/src/layers/shared/ui/sidebar.tsx` — Shadcn sidebar primitives (`SidebarContent` has overflow-auto)

- **Shared dependencies:**
  - `apps/client/src/layers/features/chat/model/use-scroll-overlay.ts` — Scroll state tracking, already has wheel/touch listeners
  - `apps/client/src/layers/shared/ui/scroll-area.tsx` — Radix ScrollArea (used by command palette, NOT by MessageList or sidebar)

- **Data flow:**
  - MessageList: `parentRef` (div) → `useVirtualizer({ getScrollElement })` → virtual items rendered → wheel/touch events tracked by `use-scroll-overlay.ts`
  - Sidebar: `SidebarContent` → native `overflow-auto` → browser scrollbar

- **Feature flags/config:** None

- **Potential blast radius:**
  - Direct: 2-3 files (`index.css`, `MessageList.tsx`, possibly `sidebar.tsx`)
  - Indirect: Any component using native scrollbars affected by global CSS change
  - Tests: `MessageList.test.tsx`, `SessionSidebar.test.tsx` (minimal, mostly behavioral)
  - The command palette's existing scrollbar fade behavior must not regress

## 4) Root Cause Analysis

N/A — This is a UI polish task, not a bug fix. However, the "always visible" behavior has a clear technical cause:

**Root cause:** The global `::-webkit-scrollbar` rules in `index.css` define `width: 6px` and a non-transparent thumb color. On macOS Chrome, any `::-webkit-scrollbar` pseudo-element with a non-zero width forces the scrollbar track to render permanently, overriding the OS "Show scroll bars: Automatic" setting. This is a well-documented browser behavior — styling webkit scrollbar pseudo-elements opts out of the OS auto-hide.

**Evidence:** The `index.css` file contains:
```css
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-thumb { background: hsl(var(--border)); border-radius: 3px; }
```

These rules apply globally to all scrollable elements, forcing scrollbar visibility on macOS.

## 5) Research

Full research report: `research/20260310_hide_scrollbars_when_idle.md`

- **Potential solutions:**

  1. **Fix root cause (remove/scope global `::-webkit-scrollbar` rules)**
     - Pros: Restores macOS native auto-hide, zero new code, fixes all scroll containers at once
     - Cons: Loses the thin custom scrollbar styling on Windows/Linux; may not provide consistent cross-platform auto-hide behavior
     - Complexity: Low

  2. **CSS + JS scroll state tracking (data attribute + opacity transitions)**
     - Pros: Zero dependencies, builds on existing wheel/touch listeners (ADR-0092), command palette already uses this pattern, full control over timing
     - Cons: Requires JS for scroll activity detection, webkit pseudo-element transitions have minor cross-browser quirks
     - Complexity: Medium

  3. **shadcn ScrollArea with `type="scroll"` and `scrollHideDelay`**
     - Pros: Built-in auto-hide, already in the project, works great for simple lists
     - Cons: Documented "Difficulty: Hard" compatibility issue with TanStack Virtual (Radix issue #1134, still open), requires viewPortRef workaround that diverges from upstream shadcn
     - Complexity: High for MessageList, Low for sidebar

  4. **OverlayScrollbars (~15KB gzip)**
     - Pros: Best-in-class scroll UX, first-class TanStack Virtual support, `autoHide: 'scroll'` built in, cross-browser
     - Cons: New dependency (~15KB), another abstraction layer over scrolling
     - Complexity: Low-Medium

  5. **Pure CSS hide (scrollbar-width: none)**
     - Pros: Trivial, zero dependencies
     - Cons: Users lose scroll position indicator entirely
     - Complexity: Trivial

- **Recommendation:** Fix the root cause first (scope/remove global `::-webkit-scrollbar` rules), then layer on CSS + JS scroll state tracking for cross-platform auto-hide behavior. This avoids new dependencies while providing the macOS-native feel everywhere.

## 6) Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Scrollbar visibility behavior | Auto-show on scroll, fade out after ~800ms | Matches macOS-native behavior. Command palette already implements this pattern. Users retain scroll position awareness during active scrolling. |
| 2 | MessageList implementation approach | CSS + JS scroll state tracking | Zero new dependencies. Builds on existing wheel/touch listeners from ADR-0092. The `use-scroll-overlay.ts` hook already tracks scroll activity — can extend it to set a `data-scrolling` attribute for CSS targeting. |
| 3 | Root cause handling | Fix root cause first, then layer on auto-hide | The global `::-webkit-scrollbar` styling is forcing scrollbar visibility. Removing/scoping it restores macOS native auto-hide. Then add CSS + JS auto-hide for consistent cross-platform behavior. |
