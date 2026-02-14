# Tab Identity: Differentiate Multiple DorkOS Browser Tabs

**Slug:** tab-identity
**Author:** Claude Code
**Date:** 2026-02-13
**Branch:** preflight/tab-identity
**Related:** N/A

---

## 1) Intent & Assumptions

- **Task brief:** When multiple DorkOS tabs are open, they all look identical — same favicon, same title. Users can't tell which tab corresponds to which project or what each is doing. We want deterministic, zero-config visual differentiation using the working directory (cwd) as the seed.
- **Assumptions:**
  - The `selectedCwd` from `useDirectoryState()` / `app-store.ts` is always available and is the right seed value
  - Canvas API is available in all target browsers (Chrome, Firefox, Edge — Safari gracefully degrades)
  - No new dependencies needed — Canvas API + simple hash function is sufficient
  - This is client-only; no server changes required
  - The Obsidian plugin does not need this (it runs inside Obsidian, not browser tabs)
- **Out of scope:**
  - User-configurable colors or emoji
  - Persisting tab identity preferences
  - Server-side favicon generation
  - PWA/service worker favicon support
  - Obsidian plugin support

---

## 2) Pre-reading Log

- `apps/client/index.html`: Static HTML template — has `<title>DorkOS</title>`, no `<link rel="icon">` tag, no existing favicon
- `apps/client/src/components/sessions/SessionSidebar.tsx`: Uses `useDirectoryState()` for `selectedCwd`, which is the value we'll use as seed
- `apps/client/src/hooks/use-directory-state.ts`: Hook for reading/writing the selected working directory
- `apps/client/src/stores/app-store.ts`: Zustand store with `selectedCwd` state
- `apps/client/src/components/chat/ChatPanel.tsx`: Main chat component — good place to mount favicon/title hooks
- `apps/client/src/components/chat/InferenceIndicator.tsx`: Already has `status: 'idle' | 'streaming' | 'error'` and `isWaitingForUser` — can derive streaming state from `useChatSession`
- `apps/client/src/hooks/use-chat-session.ts`: Exposes `isLoading` (streaming state), `messages`, `status`
- `apps/client/src/hooks/use-task-state.ts`: Has `activeForm` — the current in-progress task description, potential source for task summary
- `apps/client/vite.config.ts`: `publicDir: 'public'` — can place a static fallback favicon there
- `apps/client/src/App.tsx`: Root component wrapping everything — alternative mount point for hooks
- `guides/architecture.md`: Hexagonal architecture, Transport interface, data flow documentation

---

## 3) Codebase Map

**Primary components/modules:**
- `apps/client/index.html` — Static template, needs fallback `<link rel="icon">` tag
- `apps/client/src/App.tsx` — Root React component, ideal mount point for global hooks (favicon + title)
- `apps/client/src/stores/app-store.ts` — Zustand store with `selectedCwd`

**New files to create:**
- `apps/client/src/lib/favicon-utils.ts` — Hash function, color generation, canvas favicon generation
- `apps/client/src/hooks/use-favicon.ts` — React hook: generates favicon on cwd change, animates during streaming
- `apps/client/src/hooks/use-document-title.ts` — React hook: sets document.title with emoji + dir name + optional task summary

**Shared dependencies:**
- `useDirectoryState()` / `useAppStore()` for `selectedCwd`
- `useChatSession()` for streaming status
- `useTaskState()` for active task description (optional, for title summary)

**Data flow:**
```
selectedCwd (Zustand/URL) → fnv1aHash(cwd) → HSL color + emoji index
  → Canvas API generates 32x32 PNG favicon → data URI → <link rel="icon">
  → Streaming status toggles solid/dimmed favicon swap (600ms interval)
  → document.title = emoji + dirName + taskSummary
```

**Feature flags/config:** None needed

**Potential blast radius:**
- Direct: 3 new files (lib, 2 hooks) + minor edits to App.tsx and index.html
- Indirect: None — purely additive side effects, no component re-renders
- Tests: 1 new test file for favicon-utils (pure functions), 1 for each hook

---

## 4) Root Cause Analysis

N/A — This is a new feature, not a bug fix.

---

## 5) Research

### Potential Solutions

**1. Canvas API + FNV-1a Hash (Recommended)**
- Description: Generate 32x32 PNG favicon via Canvas, using FNV-1a hash of cwd to derive HSL color. Two-frame swap animation (solid/dimmed) during streaming.
- Pros:
  - Zero dependencies — Canvas API is built into all browsers
  - Fast (~2-3ms per generation), negligible overhead
  - Deterministic — same cwd always produces same color/emoji
  - Simple two-frame animation avoids complexity
  - Graceful degradation on Safari (static color, no animation)
- Cons:
  - Safari blocks dynamic favicon updates entirely (static fallback only)
  - Canvas emoji rendering varies by OS
- Complexity: Low
- Maintenance: Low

**2. SVG Data URI Favicon**
- Description: Generate SVG string with fill color derived from hash, encode as data URI.
- Pros:
  - No Canvas API needed, string-only generation
  - Scalable to any size
- Cons:
  - Safari SVG favicon support is inconsistent
  - Animation requires re-generating SVG string each frame
  - URL-encoding SVG strings is error-prone
- Complexity: Medium
- Maintenance: Low

**3. Pre-generated Sprite Sheet**
- Description: Create 20-30 colored favicon PNGs at build time, select by hash index.
- Pros:
  - Zero runtime cost
  - Works in Safari
- Cons:
  - Limited palette (fixed set of colors)
  - No emoji support
  - Build step complexity
  - Can't animate (no dynamic swapping on Safari anyway)
- Complexity: Medium
- Maintenance: Medium

### Recommendation

**Canvas API + FNV-1a Hash** — Simplest implementation, zero dependencies, proven pattern (used by Gmail, Slack for notification badges). Safari limitation is acceptable since DorkOS is primarily a dev tool used in Chrome.

### Key Technical Details

- **FNV-1a hash**: Better distribution than djb2 for short strings like directory paths. ~5 lines of code.
- **HSL color**: Hash mod 360 for hue, fixed 70% saturation + 55% lightness for vibrant but readable colors
- **Emoji set**: Curated ~30 face emojis (deterministically selected via hash). Used in title only, not in favicon (cross-platform rendering issues).
- **Animation**: `setInterval(600ms)` swapping between solid and 50% opacity versions. Browsers throttle background tabs to ~1 FPS, so this handles itself.
- **Title format**: `{emoji} {dirName} - {taskSummary} - DorkOS` (taskSummary optional)
- **Task summary source**: `useTaskState().activeForm` (the in-progress task's present-tense description, e.g., "Running tests") — already parsed from JSONL. Falls back to empty.

### Browser Compatibility

| Feature | Chrome | Firefox | Edge | Safari |
|---------|--------|---------|------|--------|
| Dynamic favicon | Yes | Yes | Yes | No (static only) |
| Favicon animation | Yes | Yes | Yes | No |
| Emoji in title | Yes | Yes | Yes | Yes |

---

## 6) Clarifications

1. **Emoji set for title prefix**: Should we use face emojis (expressive, fun) or geometric/object emojis (more "professional")? Face emojis are more visually distinct at small tab sizes.

2. **Task summary in title**: The `activeForm` from `useTaskState()` provides descriptions like "Running tests" or "Fixing authentication bug". Should we use this as the task summary, or try to extract something from the most recent assistant message instead? `activeForm` is simpler and already available.

3. **Favicon shape**: Should the generated favicon be a filled circle (softer, more modern) or a filled square/rounded-square (more traditional favicon shape)?

4. **Mount point**: Should the hooks be mounted in `App.tsx` (always active) or in `ChatPanel.tsx` (only when chat is visible)? `App.tsx` ensures tab identity is always set, even before a chat session is selected.

5. **Safari fallback**: Since Safari blocks dynamic favicons, should we add a static colored SVG favicon in `index.html` as a permanent fallback, or just accept that Safari users get no favicon?
