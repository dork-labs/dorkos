---
slug: pip-panel
id: 260711-150300
created: 2026-07-11
status: specified
---

# Floating picture-in-picture panel for the cockpit

**Status:** Approved
**Author:** Claude (flow SPECIFY, DOR-296)
**Date:** 2026-07-11

## Overview

A cockpit-native floating panel — like a video mini-player — that stays on top while the operator navigates: draggable, resizable, geometry-persistent, and mounted once per shell so it survives route changes. DOR-296 ships the reusable primitive, its state slice, and the content host; the panel knows nothing about what it displays. Two accepted consumers plug in next: MCP Apps' `pip` display mode (DOR-297) and live gen-UI widgets (DOR-298).

## Background / Problem Statement

MCP Apps host support v1 (spec `mcp-apps-host`, decision D5) deferred the `pip` display mode solely because "no floating surface yet" exists. Separately, the operator wants to pop interactive gen-UI widgets (tic-tac-toe) out of the transcript and keep playing while working elsewhere. Both need the same missing primitive. The browser's Document Picture-in-Picture API is not an option: Chromium-only, awkward with strict-sandbox iframes, and dead in Electron and the Obsidian embedded shell. DorkOS needs its own floating surface that works on every client surface.

## Goals

- A generic, content-blind floating panel primitive: drag, resize, viewport clamping, close/restore chrome, title.
- Survives route navigation (mounted at the shell singleton tail, outside the router outlet) and works in the router-free Obsidian embedded shell.
- Position and size persist across reloads; a reset wipes them with the rest of the preferences.
- Single instance; opening new content replaces the current content.
- A Dev Playground showcase that exercises the full surface (open, drag, resize, replace, close) so the primitive is verifiable before its consumers exist.

## Non-Goals

- The consumers themselves: MCP Apps `pip` routing (DOR-297) and live widget binding (DOR-298).
- Browser Document PiP API or OS-level always-on-top windows.
- Multiple simultaneous panels / stacking (explicitly staged later).
- Persisting panel _content_ across reloads (geometry only).
- Mobile PIP: unavailable below 768px in v1 (bottom-sheet dock is a captured follow-up).
- New runtime dependencies.

## Technical Dependencies

None new. Uses installed React 19, Zustand (app-store composition), Tailwind 4 tokens, and hand-rolled pointer events (precedents: `DevToolsPanel` in `main.tsx:73-100`, `ScrollThumb.tsx`).

## Detailed Design

### Architecture (ideation D1)

Three pieces, mirroring the canvas pattern (slice in `shared/model/app-store/`, content routing in a feature, generic UI in `shared/ui`):

1. **`apps/client/src/layers/shared/ui/floating-panel.tsx`** — the presentational primitive. Controlled component; owns gesture mechanics only, zero business logic, no store or router imports.

   ```tsx
   interface FloatingPanelGeometry {
     x: number;
     y: number;
     width: number;
     height: number;
   }

   interface FloatingPanelProps {
     title: string;
     geometry: FloatingPanelGeometry;
     onGeometryChange: (g: FloatingPanelGeometry) => void;
     onClose: () => void;
     /** Renders a restore control when provided (e.g. "send back inline"). */
     onRestore?: () => void;
     minWidth?: number; // default 280
     minHeight?: number; // default 180
     children: React.ReactNode;
     className?: string;
   }
   ```

   - Portals to `document.body`; container `fixed z-40` (ideation D7: above content and sticky chrome, below the Radix `z-50` modal/popover layer — dialogs must cover a mini-player).
   - Header: drag region (pointer capture on `pointerdown`, move on `pointermove`, release on `pointerup`/`pointercancel`) + title (truncated) + icon controls (restore when `onRestore` present, close), each with `aria-label`, sized `size-(--size-icon-sm)`.
   - Resize: single bottom-right handle, pointer capture, `cursor-nwse-resize`.
   - Clamping: geometry clamped to the visual viewport on every drag/resize frame and on `window.resize` (panel always at least partially reachable; min size enforced; max = viewport minus an 8px margin).
   - Chrome: `bg-card border border-border rounded-lg shadow-floating overflow-hidden`; entrance/exit ~150ms ease-out fade+scale (no bounce). `role="complementary"`, `aria-label={title}`. Escape does **not** close (non-modal, ideation D8).
   - shadcn-style conventions: `data-slot="floating-panel"`, `cn()` merging, plain ref props (no `forwardRef`), TSDoc on exports.

2. **`apps/client/src/layers/shared/model/app-store/app-store-pip.ts`** — the state slice, composed into `useAppStore` (`app-store.ts`).

   ```ts
   /** Serializable descriptor — never a React node (ideation D4). */
   type PipContent = { kind: 'demo'; title: string };
   // DOR-297 adds { kind: 'mcp_app'; sessionId; serverName; uri; title }
   // DOR-298 adds { kind: 'widget'; sessionId; ... }

   interface PipSlice {
     pipContent: PipContent | null;
     pipGeometry: FloatingPanelGeometry | null; // null → default dock bottom-right
     openPip: (content: PipContent) => void; // replaces current content (D3)
     closePip: () => void;
     setPipGeometry: (g: FloatingPanelGeometry) => void; // persists
   }
   ```

   - Persistence (ideation D5): manual localStorage via `app-store-helpers.ts` conventions; new key in `STORAGE_KEYS` (`layers/shared/lib/constants.ts`), e.g. `PIP_PANEL_STATE`, storing geometry only. Hydrated at slice creation; clamped on load. Added to the `resetPreferences()` wipe list (`app-store.ts:201-232`).
   - `PipContent` union lives in this slice module and is extended by consumer PRs. `pipContent` is never persisted.

3. **`apps/client/src/layers/features/pip-panel/`** — the content host feature (`ui/PipHost.tsx`, `index.ts`).
   - Reads the slice; renders nothing when `pipContent` is null.
   - Computes the default geometry (bottom-right dock, e.g. 360×240 at 16px margins) when `pipGeometry` is null.
   - Routes content by `kind` (switch — UI composition across features is FSD-legal, exactly like `features/canvas` rendering `mcp_app`). v1 ships only the trivial `demo` renderer (used by the playground showcase and tests).
   - Provides `onRestore` per content kind when a restore target exists (none for `demo`; DOR-297 wires "back to inline/canvas").
   - Mobile guard (ideation D2): when `useIsMobile()` is true, renders nothing and closes any open content via an effect, so crossing the breakpoint degrades gracefully.
   - **Renderer identity must be stable**: the kind→component map is module-scope, never an inline closure (the `StreamingText.tsx:40-49` remount hazard — recreating renderer identity remounts the content tree and destroys in-flight state; this matters the moment DOR-298 puts a latched widget inside).

### Mount points (ideation D6)

- `apps/client/src/AppShell.tsx`: `<PipHost />` appended to the singleton tail next to `DialogHost` / `CommandPaletteDialog` / `Toaster` (~lines 363-367) — outside the `PanelGroup`, so it never remounts on navigation.
- `apps/client/src/App.tsx` (Obsidian embedded, router-free): same, appended next to its `CommandPaletteDialog` / `Toaster` tail (~lines 154-156). No router imports anywhere in the primitive, slice, or host.

### API changes

None (client-only; no server or shared-package changes).

### Data model changes

One new localStorage key (geometry). No DB or schema changes.

## User Experience

DOR-296 has no end-user entry point by design — consumers add the "pop out" affordances. The interaction contract the primitive ships:

1. A feature calls `openPip(content)` → the panel fades in at its persisted (or default bottom-right) position, titled by the content.
2. The operator drags it by the header anywhere in the viewport; resizes from the bottom-right corner; both clamp to the viewport and min size.
3. Navigating between routes leaves the panel exactly where it is, content still mounted.
4. Opening different content replaces what's shown (single instance).
5. Close (`×`) hides the panel; restore (when offered) sends content back to its origin and closes.
6. Below 768px the panel does not render and open content closes; pop-out affordances are hidden by consumers on mobile.
7. Dialogs, sheets, and menus open above the panel; the panel floats above everything else.

Verification surface: a Dev Playground showcase (`apps/client/src/dev/`, per the playground registry conventions) drives open/replace/close/drag/resize with the `demo` content kind.

## Testing Strategy

- **Unit tests (RTL + jsdom, in `__tests__/` alongside source):**
  - `floating-panel.test.tsx`: renders children + title; drag via synthetic pointer events updates geometry through `onGeometryChange`; resize respects min size; clamping at viewport edges; window resize re-clamps; close/restore callbacks fire; restore control absent without `onRestore`; a11y roles and `aria-label`s present; Escape does not close.
  - `app-store-pip.test.ts`: open/replace/close semantics; geometry persists to the storage key and hydrates clamped; `resetPreferences()` wipes it; content never persisted.
  - `PipHost.test.tsx`: null content renders nothing; `demo` kind renders; default geometry when unpersisted; mobile guard closes and hides (mock `useIsMobile`); renderer map identity stable across re-renders (no remount — spy via effect cleanup counting).
- **Integration:** shell-level test asserting `PipHost` stays mounted across a route change (router test harness with mock `Transport` via `TransportProvider`).
- **E2E:** none in v1 (no user-facing entry point); the playground showcase is the manual/visual verification surface. Consumers add e2e when affordances exist.
- **Mocking:** localStorage mocked per existing app-store test patterns; no network.

## Performance Considerations

Drag/resize handlers write geometry via `requestAnimationFrame`-throttled updates (or equivalent) to avoid re-render storms; the panel body is not re-created during gestures (geometry applied to the container only). Persistence writes debounce to gesture end (write on `pointerup`, not per-frame). Nothing renders when `pipContent` is null.

## Security Considerations

None introduced by the primitive: it renders trusted first-party content descriptors. Consumer-specific gates remain the consumers' responsibility — notably MCP Apps' per-server render consent (`model/render-consent.ts`) must sit inside the routed content, never bypassed by PIP placement (restated in DOR-297's scope).

## Documentation

- TSDoc on all exports (enforced).
- Dev Playground showcase registration (developer-facing verification).
- No user-facing docs in DOR-296 (no user-visible feature yet); DOR-297/298 carry the docs + changelog fragments for the visible behavior. A changelog fragment is still added for the primitive per repo convention (developer-visible surface).

## Implementation Phases

- **Phase 1 — the primitive + state (core):** `floating-panel.tsx` with gestures/clamping/chrome + `app-store-pip.ts` slice with persistence + unit tests.
- **Phase 2 — the host + shells:** `features/pip-panel/` host with `demo` kind, mobile guard, mounts in both shells, route-persistence integration test.
- **Phase 3 — verification polish:** Dev Playground showcase; a11y pass; design-token review against `contributing/design-system.md`.

(One PR; phases are ordering, not separate deliverables.)

## Open Questions

- ~~Mobile behavior — bottom sheet vs unavailable?~~ **(RESOLVED)** Answer: unavailable below 768px in v1; pop-out affordances hidden; open panel closes on breakpoint cross. Rationale: drag/resize is pointer-native; the repo's mobile degradation for floating surfaces (full-width sheet) collapses into the inline view for chat-borne content — high complexity, low value. Bottom-sheet dock captured as a follow-up issue at DONE.
- ~~Single instance vs stacking?~~ **(RESOLVED)** Answer: single instance, replace-on-open. Rationale: staged in the capture; simplest predictable semantic; the descriptor model does not preclude a stack later.
- ~~Where does the content union live?~~ **(RESOLVED)** Answer: in the `app-store-pip.ts` slice module, extended by consumer PRs. Rationale: client-only concern; `@dorkos/shared` is for cross-package contracts and none exists here.
- ~~Position persistence scope — global or per-context?~~ **(RESOLVED)** Answer: one global geometry key. Rationale: right-panel's per-key LRU (DOR-227) solved a real per-agent divergence; no evidence PIP needs that yet; trivially extensible later.

## Related ADRs

- `260711-150550-cockpit-native-pip-panel-over-document-pip-api.md` (seeded from this spec)
- `260711-150551-pip-content-descriptors-routed-by-host-feature.md` (seeded from this spec)
- ADR 260708-\* (mcp-apps-host D5/D6 context: display modes, sandbox posture) — constrains DOR-297, not this primitive.

## References

- Linear: DOR-296 (this), DOR-297 + DOR-298 (consumers, typed `blocks` relations).
- `specs/pip-panel/01-ideation.md` — discovery detail and decision rationale (D1–D9).
- `specs/mcp-apps-host/01-ideation.md` (D5), `02-specification.md` §2.2 (`McpAppRefSchema` already types `pip`).
- Precedents: `app-store-canvas.ts`, `app-store-right-panel.ts`, `DevToolsPanel` (`main.tsx:73-100`), `ResponsiveDialog`, `RightPanelContainer`.
- `contributing/design-system.md` (elevation/motion/mobile-scale), `.claude/rules/components.md`, `.claude/rules/fsd-layers.md`.
