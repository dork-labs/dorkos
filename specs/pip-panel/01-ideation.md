---
slug: pip-panel
created: 2026-07-11
status: ideation
---

# Floating picture-in-picture panel for the cockpit

**Slug:** pip-panel
**Author:** Claude (flow IDEATE, DOR-296)
**Date:** 2026-07-11
**Tracker:** DOR-296 - Build a floating picture-in-picture panel for the cockpit

---

## 1) Intent & Assumptions

- **Task brief:** A small floating window inside the cockpit (like a video mini-player) that stays on top while you navigate — draggable, resizable, and persistent across route changes. It is the foundation for two captured consumers: MCP Apps' deferred `pip` display mode (DOR-297) and popping live gen-UI widgets out of the transcript (DOR-298, "play tic-tac-toe in PIP"). Cockpit-native panel, **not** the browser Document Picture-in-Picture API (Chromium-only, awkward with strict-sandbox iframes, dead in Electron/Obsidian) — decided with the operator at capture.
- **Assumptions:**
  - The panel is a reusable primitive: it knows nothing about MCP apps or gen-UI widgets. Content routing lives one level up (feature host), mirroring how the canvas routes `UiCanvasContent` variants.
  - Single instance in v1 (the issue says "single instance to start; decide stacking later").
  - DOR-296 ships the primitive + host + a Dev Playground showcase; it has no end-user entry point until DOR-297/298 add "pop out" affordances. That is acceptable staging, not dead code — both consumers are accepted, readied issues.
  - Consumers own their hard problems: off-route SSE liveness and `isLatestMessage` re-derivation are DOR-298's scope; display-mode grant/routing is DOR-297's. The primitive must merely not preclude them (content receives `sessionId`-shaped props and stays mounted across route changes).
- **Out of scope:**
  - Browser Document PiP API, OS-level always-on-top windows (Electron `BrowserWindow` flags).
  - Multiple simultaneous PIP panels / stacking.
  - Persisting PIP _content_ across reloads (geometry persists; content is ephemeral in v1).
  - Mobile PIP (decision D2 below: unavailable on < 768px in v1; bottom-sheet dock is a captured follow-up).
  - The consumers themselves (DOR-297 MCP Apps routing, DOR-298 live widget binding).

## 2) Pre-reading Log

- `specs/mcp-apps-host/01-ideation.md` (D5): `pip` deferred solely because "no floating surface yet"; advertise set is `["inline","fullscreen"]`.
- `specs/mcp-apps-host/02-specification.md` §2.2/§3: `McpAppRefSchema` already types `preferredDisplayMode?: 'inline'|'fullscreen'|'pip'` — shared schema needs no change for 297.
- Linear DOR-296/297/298 descriptions — capture-stage ground truth for requirements and consumer sketches.
- Two discovery sweeps over `apps/client` (app shell/overlay/persistence terrain; mcp-apps + gen-ui consumer requirements). Findings below.

## 3) Codebase Map

- **Shells (both must mount the host):**
  - `apps/client/src/AppShell.tsx` — web/Electron shell. Pathless `_shell` layout route (`router.tsx:39-43`) renders it once for all routes; the `<Outlet/>` sits inside a `PanelGroup` (line ~349-354). Route-persistent singletons (`DialogHost`, `CommandPaletteDialog`, `ShortcutsPanel`, `Toaster`) mount at the component tail (lines ~363-367) **outside** the panel tree — the PIP host mounts there.
  - `apps/client/src/App.tsx` — Obsidian embedded shell, **no router at all**; duplicates the same singleton tail (lines ~154-156). The primitive must never touch router hooks.
- **State precedent:** `apps/client/src/layers/shared/model/app-store/app-store-canvas.ts` (Zustand slice composed in `app-store.ts:237`; typed `CanvasDocument` union, dedup by source key, manual localStorage persistence) and `app-store-right-panel.ts` (persisted panel layout: global fallback + per-key LRU map, DOR-227).
- **Persistence conventions:** no Zustand `persist` middleware anywhere — hand-rolled `localStorage` via `app-store-helpers.ts`, keys centralized in `layers/shared/lib/constants.ts` (`STORAGE_KEYS`), every key wiped in `resetPreferences()` (`app-store.ts:201-232`).
- **Drag/resize terrain:** installed libs: `motion@12`, `react-resizable-panels@3`, `vaul`, `radix-ui`. **No** `react-rnd` / `@use-gesture` / `re-resizable`. Working hand-rolled precedents: `DevToolsPanel` drag-resize (`main.tsx:73-100`), `ScrollThumb.tsx` pointer-capture drag. Motion's `drag` prop used once (mobile swipe on `ChatStatusSection.tsx:516`).
- **Mobile:** `useIsMobile()` (`layers/shared/model/use-is-mobile.ts`, breakpoint 768). Convention: floating surfaces degrade to full-width `vaul` Drawer / Radix Sheet on mobile (`ResponsiveDialog`, `RightPanelContainer.tsx:136-153`).
- **z-index terrain:** no token scale; Radix portal content is uniformly `z-50`; embedded sidebar backdrop `z-40`; `ServerRestartOverlay` `z-[100]`; DevTools `z-[9999]`. All portals target `document.body`.
- **Design system:** purpose-named elevation token `shadow-floating` exists (`index.css:359-373`); panels use `rounded-lg`, `bg-card`, `border-border`; entrances `ease-out` 100-300ms; icon controls need `aria-label` + `size-(--size-icon-*)` tokens; new primitives follow shadcn style (`cva`, `data-slot`, `cn()`, React 19 plain ref props).
- **Consumer surfaces (verified portable):**
  - `McpAppFrame` (`features/mcp-apps/ui/McpAppFrame.tsx:27-40`) is fully self-contained: props `{sessionId, serverName, uri, title?, onRequestFullscreen?}`; owns its bridge lifecycle + TanStack Query; consent gate (`model/render-consent.ts`) is a localStorage hook orthogonal to placement.
  - `WidgetRenderer` (`features/gen-ui/ui/WidgetRenderer.tsx`) needs only `{document, sessionId, isLatestMessage}`; `WidgetActionProvider` takes `sessionId` as a prop, never from route context.
- **Potential blast radius:** `AppShell.tsx` + `App.tsx` (one mount line each), `app-store.ts` (slice composition + `resetPreferences`), `constants.ts` (storage key), new `layers/shared/ui/` primitive, new `layers/features/pip-panel/` slice, Dev Playground registry.

## 4) Root Cause Analysis

Not a bug fix — omitted.

## 5) Research

**Potential solutions for the floating mechanics:**

1. **Hand-rolled pointer-event drag + resize (recommended).** Pointer capture on a header drag region and a corner resize handle; geometry as controlled state; viewport clamping on move/resize/window-resize.
   - Pros: zero new dependencies; two in-repo precedents (`DevToolsPanel`, `ScrollThumb`); full control over clamping + persistence; trivially testable.
   - Cons: ~150 lines of gesture code we own.
2. **Motion `drag` prop + `useDragControls`.** Motion is installed.
   - Pros: momentum/constraints for free.
   - Cons: motion drag manages transform internally, which fights controlled persisted x/y and a separate resize gesture; the one in-repo usage is a tiny swipe, not a precedent for a windowing surface; harder to clamp deterministically.
3. **New dependency (`react-rnd` / `re-resizable`).**
   - Pros: batteries included. Cons: new dep for ~150 lines of behavior; repo convention is lean deps; rejected.

**Recommendation:** Option 1. Also: portal to `document.body` at `z-40` — above all in-flow content and sticky chrome (`z-10..30`), below the Radix modal/popover layer (`z-50`), so dialogs, sheets, and menus correctly cover the PIP while it floats over everything else. A mini-player that yields to modals matches platform conventions (and the embedded shell's own `z-40` backdrop semantics).

## 6) Decisions

| #   | Decision                       | Choice                                                                                                                                                                                                                                           | Rationale                                                                                                                                                                                  |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Architecture split             | Generic mechanics in `layers/shared/ui/floating-panel.tsx` (portal, drag, resize, clamp, chrome slots — zero business logic); PIP state as `app-store-pip.ts` slice; content routing in `layers/features/pip-panel/` host mounted once per shell | Mirrors canvas exactly (slice in shared/model, host feature routes typed content, UI composition across features is FSD-legal); shared/ui primitive stays importable everywhere            |
| D2  | Mobile behavior                | Unavailable below 768px in v1: pop-out affordances hidden; if the viewport crosses the breakpoint while open, the panel closes (content returns to its inline home). Bottom-sheet dock captured as a follow-up issue                             | Drag/resize is pointer-native; repo convention degrades floating surfaces to full-width sheets, which for chat-borne content is just the inline view again — high complexity, low v1 value |
| D3  | Single instance vs stacking    | Single instance; `openPip` on an occupied panel replaces content (no queue, no stack)                                                                                                                                                            | Issue explicitly staged stacking for later; replace-on-open is the simplest predictable semantic                                                                                           |
| D4  | Content contract               | Serializable descriptor `{ type, title, props }` in the store; the feature host switches on `type` to render (v1 ships the shell + a playground-only demo type; `mcp_app` and `widget` types arrive with DOR-297/298)                            | Keeps React nodes out of the store (devtools/persistence-safe); canvas precedent; primitive stays content-blind                                                                            |
| D5  | Geometry persistence           | One global localStorage key (`STORAGE_KEYS.PIP_PANEL_STATE`) holding `{x, y, width, height}`; clamped to viewport on load, drag, resize, and window resize; default dock bottom-right; wiped by `resetPreferences()`                             | Right-panel precedent, minus the per-key LRU (no evidence PIP needs per-agent geometry yet)                                                                                                |
| D6  | Route + embedded compatibility | No router imports anywhere in the primitive or host; host mounted in both `AppShell.tsx` and `App.tsx` singleton tails                                                                                                                           | Obsidian shell has no router; route-persistence falls out of mounting outside the `Outlet`                                                                                                 |
| D7  | Layering                       | Portal to `document.body`, `z-40`                                                                                                                                                                                                                | Above content/sticky chrome, below the `z-50` modal/popover layer — dialogs must cover a mini-player                                                                                       |
| D8  | Chrome & a11y                  | Header = title (from descriptor) + drag region; controls: close, restore (fires the descriptor's `onRestore` intent when present). `role="complementary"`, labelled controls, Escape does **not** close (panel is non-modal)                     | Calm-tech: minimal chrome, `bg-card`/`border-border`/`shadow-floating`/`rounded-lg`; restore is the seam DOR-297 needs for "dock back to inline/canvas"                                    |
| D9  | Gesture implementation         | Hand-rolled pointer events with pointer capture; drag via header, resize via bottom-right handle; min size ~280×180, max = viewport minus margin                                                                                                 | §5 recommendation — no new dependency, in-repo precedents                                                                                                                                  |

**Next step:** move to SPECIFY (`02-specification.md`) — the design is settled enough to freeze; no open questions require the operator (mobile and stacking were the two genuine ambiguities and both had a staged-scope answer consistent with the issue text).
