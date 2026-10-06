---
slug: canvas-persistence-and-toggle
number: 189
created: 2026-03-28
status: ideation
---

# Canvas Persistence & Toggle

**Slug:** canvas-persistence-and-toggle
**Author:** Claude Code
**Date:** 2026-03-28

---

## 1) Intent & Assumptions

**Task brief:** Two related canvas improvements shipped as one coherent unit:

1. **Persist canvas state across page refreshes**, scoped per session
2. **Add a toggle button** so users can reopen the canvas after closing it

The toggle is a prerequisite for persistence being useful — if you can't reopen the canvas, persisted state is invisible to the user. Shipping together makes the canvas feature "complete."

**Assumptions:**

- Canvas state (open/closed, content) should persist per session, not globally
- Panel width is a global layout preference (already persisted by `react-resizable-panels` via `autoSaveId`)
- The toggle button belongs in the session header, not the dashboard header
- The toggle should be always-visible, mirroring the sidebar toggle pattern
- No backend changes needed — localStorage is sufficient for client-side persistence

**Out of scope:**

- Server-side canvas state persistence (cross-device sync)
- Canvas auto-update when content changes (separate feedback item)
- Canvas extensions system
- Splash screen redesign (separate feedback item)

## 2) Pre-reading Log

- `apps/client/src/layers/features/canvas/ui/AgentCanvas.tsx`: Canvas component with desktop Panel and mobile Sheet branches. Uses `bg-sidebar`, thin resize handle, `CanvasBody` extraction.
- `apps/client/src/layers/shared/model/app-store.ts`: Zustand store. Canvas state at lines 150-157 is explicitly commented "transient — not persisted." Sidebar persistence uses `readBool`/`writeBool` helpers. Complex state (e.g., `recentCwds`) uses direct `localStorage.setItem` with JSON serialization.
- `apps/client/src/layers/shared/model/app-store-helpers.ts`: `readBool`/`writeBool` helpers at lines 7-23. `BOOL_KEYS` registry at lines 36-59.
- `apps/client/src/layers/shared/lib/constants.ts`: `STORAGE_KEYS` object for localStorage key names.
- `apps/client/src/layers/entities/session/model/use-session-id.ts`: Session ID comes from TanStack Router search params (`?session=<id>`) in standalone mode, Zustand in embedded (Obsidian) mode.
- `apps/client/src/layers/widgets/session/ui/SessionPage.tsx`: Renders `PanelGroup` with `ChatPanel` + `AgentCanvas`. Session ID derived from route.
- `apps/client/src/layers/features/top-nav/ui/SessionHeader.tsx`: Session route header — where the toggle button should go.
- `apps/client/src/layers/shared/ui/sidebar.tsx`: Reference pattern for mobile Sheet + desktop panel toggle. Uses `useIsMobile()` hook.
- `packages/shared/src/schemas.ts`: `UiCanvasContentSchema` — discriminated union of `url | markdown | json` types (lines 1140-1159). All three are JSON-serializable.
- `meta/personas/the-autonomous-builder.md`: Kai runs 10-20 sessions/week across 5 projects. Expects tools to maintain context.
- `meta/archive/personas/the-knowledge-architect.md`: Priya's core emotional need is flow preservation. Context-switching costs 15 minutes of mental state.
- `research/20260328_multi_panel_toggle_ux_patterns.md`: Comprehensive research on panel toggle UX from VS Code, Cursor, Figma, Obsidian, Linear. Key finding: always-visible toggle button is load-bearing infrastructure.

## 3) Codebase Map

**Primary components/modules:**

- `apps/client/src/layers/features/canvas/ui/AgentCanvas.tsx` — Canvas component (both branches)
- `apps/client/src/layers/features/canvas/ui/CanvasHeader.tsx` — Canvas header with close button
- `apps/client/src/layers/features/top-nav/ui/SessionHeader.tsx` — Session route header (toggle button target)
- `apps/client/src/layers/shared/model/app-store.ts` — Zustand store (canvas state + persistence)
- `apps/client/src/layers/shared/lib/constants.ts` — Storage key constants

**Shared dependencies:**

- `useAppStore` — Zustand store hook (canvas state selectors)
- `useIsMobile` — Mobile breakpoint hook
- `useSessionId` — Session ID from route
- `STORAGE_KEYS` / `BOOL_KEYS` — localStorage key registries
- `UiCanvasContent` type from `@dorkos/shared/types`

**Data flow:**

- Toggle button click → `setCanvasOpen(true/false)` → Zustand store → AgentCanvas re-renders
- Agent sends canvas content → `setCanvasContent(content)` → Zustand store → AgentCanvas renders content
- Session switch (URL change) → `useSessionId` returns new ID → canvas state loaded from localStorage for that session
- Page refresh → Zustand store initializes → reads localStorage for current session ID → restores canvas state

**Potential blast radius:**

- Direct: `app-store.ts`, `constants.ts`, `AgentCanvas.tsx`, `SessionHeader.tsx` (or new `CanvasToggle.tsx`)
- Indirect: `SessionPage.tsx` (may need to pass session ID context), command palette actions
- Tests: `AgentCanvas.test.tsx`, `SessionHeader.test.tsx`, new toggle tests

## 5) Research

### Canvas Persistence — Per-Session Storage

**Approach: Session-keyed localStorage map**

- Store a map of `{ [sessionId]: { open: boolean, content: UiCanvasContent | null } }` in localStorage under a single key (e.g., `dorkos-canvas-sessions`)
- On session load/switch, read the entry for the current session ID and hydrate Zustand
- On canvas state change, write back to localStorage keyed by session ID
- Cap at ~50 most-recently-accessed entries to prevent unbounded growth (LRU eviction)
- Panel width remains global (already handled by `react-resizable-panels` `autoSaveId`)

**User's rationale for per-session (not global):**

1. Different spec docs open in different session tabs — switching tabs should show the correct doc
2. Same agent, different branches — same document might have different versions per session
3. Canvas open in one session, closed in another — personal preference per work context

**Serialization:** All three `UiCanvasContent` variants (`url`, `markdown`, `json`) are JSON-serializable. `url` stores a URL string, `markdown` stores content string, `json` stores arbitrary data. No special handling needed beyond `JSON.stringify`/`JSON.parse`.

**Edge cases:**

- New session with no stored state → default to closed, no content
- Stored session references content that no longer exists → show stale content (user can close); future "auto-update" feature will address this
- Very large markdown content in localStorage → localStorage has ~5MB limit; a single large doc is unlikely to hit this, but the LRU cap prevents accumulation

### Canvas Toggle — UX Pattern

**Approach: Always-visible toggle button in SessionHeader**

Industry research (VS Code, Cursor, Figma, Obsidian) converges on one pattern: an always-visible icon button in the toolbar, on the same side as the panel it controls, backed by a keyboard shortcut.

**Desktop:**

- `PanelRight` icon button in `SessionHeader`, far right (after command palette trigger)
- When canvas is open: icon variant changes (e.g., `PanelRightClose` or filled)
- Keyboard shortcut symmetric with sidebar toggle (check what sidebar uses first)
- Register "Toggle Canvas" in command palette

**Mobile:**

- Same button in the header, triggers Sheet open/close
- Sheet overlay dismiss (tap outside) and CanvasHeader close button also work for closing

**State indicator:**

- When canvas is closed but has persisted content for this session: subtle dot on the toggle button
- This tells the user "there's something here" without being noisy
- Uses the `canvasContent` from the session's persisted state to determine visibility

**Anti-patterns avoided:**

- Hiding the toggle when canvas is empty (locks users out — Cursor bug report precedent)
- Hover-only triggers (fails on mobile)
- Command palette as the only way to open (invisible mailbox anti-pattern)

## 6) Decisions

| #   | Decision                | Choice                                    | Rationale                                                                                                                                                                                      |
| --- | ----------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Scope                   | Ship toggle + persistence together        | Toggle is prerequisite for persistence being useful — can't experience persisted state if you can't reopen the canvas                                                                          |
| 2   | Persistence scope       | Per-session (not global)                  | User has different docs in different sessions, different branches with different doc versions, and different open/closed preferences per session                                               |
| 3   | Storage mechanism       | localStorage with session-keyed map       | No backend changes needed. Follows existing codebase patterns. All `UiCanvasContent` variants are JSON-serializable                                                                            |
| 4   | Panel width persistence | Per-session (session-scoped `autoSaveId`) | User may want different widths per session (e.g. wide canvas for a spec doc, narrow for a URL preview). Dynamic `autoSaveId` per session ID lets `react-resizable-panels` handle this natively |
| 5   | Toggle button location  | SessionHeader, far right                  | Mirrors sidebar toggle on the left. Always visible. Industry standard (VS Code, Cursor, Obsidian)                                                                                              |
| 6   | State indicator         | Dot on toggle when closed with content    | Tells user "there's something here" without being noisy                                                                                                                                        |
| 7   | LRU cap                 | ~50 sessions                              | Prevents unbounded localStorage growth while keeping recent context                                                                                                                            |
