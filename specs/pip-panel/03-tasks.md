# Tasks: Floating picture-in-picture panel for the cockpit

Spec: `specs/pip-panel/02-specification.md` · Slug: `pip-panel` · Mode: full

One PR; phases below are ordering, not separate deliverables. 7 tasks across 3 phases. Phase 1's two tasks are independent (different files, no shared imports) and can run in parallel; everything else has a real dependency chain.

## Phase 1: Foundation: primitive + state

### Task 1.1: Build the floating-panel primitive (drag, resize, clamp, chrome, a11y)

**Size:** large · **Priority:** high · **Dependencies:** none · **Parallel with:** 1.2

Create the presentational floating-panel primitive at `apps/client/src/layers/shared/ui/floating-panel.tsx`. It is a controlled component: geometry lives entirely in props, the primitive owns gesture mechanics only, and it must not import the app store, `useAppStore`, or any router hook — verify with `grep -n "app-store\|react-router" apps/client/src/layers/shared/ui/floating-panel.tsx` returning nothing.

Export exactly this shape verbatim:

```tsx
export interface FloatingPanelGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FloatingPanelProps {
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

export function FloatingPanel(props: FloatingPanelProps): React.ReactNode;
```

Also export a pure helper `clampGeometry(geometry, minWidth, minHeight)`: caps `width`/`height` to at least the min and at most `window.innerWidth - 16` / `window.innerHeight - 16` (8px margin per edge); clamps `x` to `[0, window.innerWidth - width]` and `y` to `[0, window.innerHeight - height]` so the panel is always fully on-screen.

Mechanics:

- Portal to `document.body`, container `fixed z-40` — this repo's `z-40` convention is the embedded sidebar backdrop (`apps/client/src/App.tsx:108`), which sits below Radix's uniform `z-50` portal layer, so dialogs/sheets/menus correctly cover the mini-player.
- Header: truncated title + close control (always) + restore control (only when `onRestore` is provided), each with `aria-label`, sized `size-(--size-icon-sm)`.
- Drag: the document-listener pointer pattern from `apps/client/src/layers/features/chat/ui/ScrollThumb.tsx` (`pointerdown` on the header attaches `pointermove`/`pointerup` to `document`, refs hold drag state). Intermediate frames write the live position IMPERATIVELY to the container's inline style (rAF-throttled) — `onGeometryChange` fires exactly ONCE, on `pointerup`/`pointercancel`, with the final clamped geometry. This is what makes "persist on pointerup, not per-frame" true by construction, since the store's `setPipGeometry` (task 1.2) only ever hears about the settled end state.
- Resize: same pattern from a single bottom-right handle (`cursor-nwse-resize`), enforcing `minWidth`/`minHeight` live, committing once on release.
- Re-clamp on `window.resize` AND once on mount, so a stale persisted geometry self-corrects the instant the panel first renders — no clamping needed in the state slice.
- Chrome: `bg-card border border-border rounded-lg shadow-floating overflow-hidden`; ~150ms ease-out fade+scale entrance/exit, no bounce.
- `role="complementary"`, `aria-label={title}`; Escape does **not** close (non-modal, ideation D8).
- `data-slot="floating-panel"`, `cn()` merging, plain `ref` prop (no `forwardRef`), TSDoc on every export.

Add `FloatingPanel`, `clampGeometry`, and both types to the `apps/client/src/layers/shared/ui/index.ts` barrel.

**Tests** (`apps/client/src/layers/shared/ui/__tests__/floating-panel.test.tsx`): renders children + title; drag calls `onGeometryChange` once with final geometry; resize respects min size; out-of-bounds geometry clamps on `window.resize` AND on mount; close/restore callbacks fire; restore control absent without `onRestore`; `role`/`aria-label` present on root and controls; Escape does not close.

### Task 1.2: Add the PIP state slice with persisted geometry

**Size:** medium · **Priority:** high · **Dependencies:** none · **Parallel with:** 1.1

Create `apps/client/src/layers/shared/model/app-store/app-store-pip.ts`, composed into `useAppStore`, mirroring `app-store-canvas.ts`/`app-store-right-panel.ts`. Export exactly:

```ts
/** Serializable descriptor — never a React node (ideation D4). */
export type PipContent = { kind: 'demo'; title: string };
// DOR-297 adds { kind: 'mcp_app'; sessionId; serverName; uri; title }
// DOR-298 adds { kind: 'widget'; sessionId; ... }

export interface PipSlice {
  pipContent: PipContent | null;
  pipGeometry: FloatingPanelGeometry | null; // null → default dock bottom-right
  openPip: (content: PipContent) => void; // replaces current content (D3)
  closePip: () => void;
  setPipGeometry: (g: FloatingPanelGeometry) => void; // persists
}
```

`FloatingPanelGeometry` is a type-only import from `@/layers/shared/ui` (task 1.1) — a legal same-layer cross-import.

Wiring:

- `constants.ts`: add `PIP_PANEL_STATE: 'dorkos-pip-panel-state'` to `STORAGE_KEYS`.
- `app-store-helpers.ts`: add `readPipGeometry()`/`writePipGeometry()` following the `readRightPanelState`/`writeRightPanelState` try/catch pattern.
- `createPipSlice`: `pipContent` starts null; `pipGeometry` hydrates raw (unclamped — the primitive clamps on display). `openPip` unconditionally replaces content (D3, no dedup unlike canvas). `closePip` nulls content only, geometry survives. `setPipGeometry` sets state AND persists — every call writes, so callers must only invoke it at gesture end (matches the primitive's single-callback contract).
- `app-store-types.ts`: add `PipSlice` to the `AppState` intersection.
- `app-store.ts`: compose `createPipSlice`; add `pipContent`/`pipGeometry` + the `PIP_PANEL_STATE` key to `resetPreferences()`'s wipe list, mirroring the existing right-panel reset lines.
- `shared/model/index.ts`: export `type { PipContent }` from the slice, next to the existing `CanvasDocument`/`BrowserHistoryState` export line.

**Tests** (`apps/client/src/layers/shared/model/app-store/__tests__/app-store-pip.test.ts`): open/replace/close semantics; `setPipGeometry` persists to `localStorage['dorkos-pip-panel-state']`; a pre-seeded key hydrates `pipGeometry` at store construction; `resetPreferences()` wipes both state and the storage key; content never appears in any persisted key.

## Phase 2: Host + shells

### Task 2.1: Build the PipHost content-routing feature

**Size:** medium · **Priority:** high · **Dependencies:** 1.1, 1.2

Create `apps/client/src/layers/features/pip-panel/` (`ui/PipHost.tsx`, `ui/DemoPipContent.tsx`, `index.ts`), mirroring how `features/canvas` routes `UiCanvasContent`.

`PipHost`:

- Reads `pipContent`/`pipGeometry`/`closePip`/`setPipGeometry` from `useAppStore`; renders `null` when `pipContent` is null.
- Mobile guard (D2): `useIsMobile()` (768px) → render `null`; a `useEffect` calls `closePip()` the moment the breakpoint is crossed while content is open.
- Default geometry when `pipGeometry` is null: `{ x: innerWidth - 376, y: innerHeight - 256, width: 360, height: 240 }` (360×240, 16px margins), recomputed every render until the first user gesture commits a persisted geometry.
- Renderer map at MODULE SCOPE (never an inline closure or `useMemo` inside the component body) — `{ demo: DemoPipContent }`. This mirrors the remount-hazard fix in `apps/client/src/layers/features/chat/ui/message/StreamingText.tsx:33-70` (`FenceContext`/`DorkosUiFence`): a renderer recreated per-render gets a fresh identity, and React unmounts/remounts the whole subtree — fatal the moment DOR-298 puts a stateful widget inside. `DemoPipContent` just renders `content.title` centered.
- Switches on `pipContent.kind` with an exhaustiveness guard so adding `'mcp_app'`/`'widget'` later is a compile error until handled.
- `onRestore` is `undefined` for `'demo'` in v1 (DOR-297 wires it for "back to inline/canvas", D8).
- `FloatingPanel`'s `onGeometryChange` wires directly to `setPipGeometry`; `onClose` wires to `closePip`.

**Tests** (`apps/client/src/layers/features/pip-panel/__tests__/PipHost.test.tsx`): null content renders nothing; `demo` kind renders; default geometry used when unpersisted; mobile guard closes+hides (mock `useIsMobile`); renderer map identity stays stable across re-renders (mount-effect spy fires once, proving no remount).

### Task 2.2: Mount PipHost in both shells and prove it survives route changes

**Size:** small · **Priority:** high · **Dependencies:** 2.1

- `apps/client/src/AppShell.tsx`: add `<PipHost />` to the singleton tail after `<Toaster />` (lines ~363-367), OUTSIDE the `<PanelGroup>` that wraps `<Outlet />`.
- `apps/client/src/App.tsx` (Obsidian embedded, no router): same, after its `<Toaster />` tail (lines ~154-156).
- Acceptance: `grep -rn "react-router\|tanstack/react-router"` across the primitive, slice, and host directories returns nothing.

**Integration test** (`apps/client/src/__tests__/pip-panel-route-persistence.test.tsx`, following `app-shell-slots.test.tsx`'s router-mocking style): render `<AppShell />` once, open PIP content via the real store, capture the panel's DOM node (`role="complementary"`), change the mocked pathname and call `rerender()` on the SAME render result (not a fresh `render()`), and assert the SAME DOM node is still present with unchanged content — proving `PipHost` never unmounts across simulated navigation.

## Phase 3: Verification polish

### Task 3.1: Add the PIP Panel Dev Playground showcase

**Size:** small · **Priority:** medium · **Dependencies:** 2.1 · **Parallel with:** 2.2, 3.2

New `apps/client/src/dev/showcases/PipPanelShowcases.tsx`, following the `OverlayShowcases.tsx` pattern. Since the Dev Playground never mounts `AppShell`/`App.tsx`, this showcase mounts `<PipHost />` itself. Controls: open (`openPip({ kind: 'demo', title: 'Demo panel A' })`), open-different (proves replace-on-open), close. Instructional copy tells the tester to drag/resize and reload to check persistence.

Register via `PlaygroundSection` entries in `apps/client/src/dev/sections/features-sections.ts` (`page: 'features'`, `category: 'PIP Panel'`), rendered from `apps/client/src/dev/pages/FeaturesPage.tsx` alongside the other `*Showcases` — reuses the existing Features page rather than adding a new `Page`/route/nav entry.

No new automated tests — this showcase is the manual verification surface until DOR-297/298 add real affordances. Confirm typecheck passes and the section renders cleanly under `pnpm dev:dogfood`.

### Task 3.2: Write the changelog fragment for the PIP panel primitive

**Size:** small · **Priority:** low · **Dependencies:** 2.1 · **Parallel with:** 2.2, 3.1

New `changelog/unreleased/<id>-pip-panel-primitive.md` with a freshly-minted `YYMMDD-HHMMSS` id (`.claude/scripts/id.ts` — do not reuse this spec's own id). Plain Markdown, no frontmatter, following `changelog/unreleased/260711-105140-marketplace-symlink-containment.md`'s shape: a single `### Added` heading, one bullet ending `(DOR-296)`. Written for a developer audience per the `writing-for-humans` skill (plain language, no em dashes) since DOR-296 has no end-user entry point yet.

### Task 3.3: Final accessibility and design-token review, then full verify

**Size:** medium · **Priority:** high · **Dependencies:** 2.2, 3.1, 3.2

- Design-token audit against `contributing/design-system.md` and `.claude/rules/components.md`: only Calm Tech tokens (`shadow-floating`, `bg-card`, `border-border`, `rounded-lg`, icon size tokens), no ad hoc colors, no bare `focus:` (must be `focus-visible:`).
- Manual accessibility pass on the playground showcase: keyboard reachability + visible focus rings on close/restore; note the lack of a keyboard-drag equivalent as a known v1 limitation rather than adding scope.
- Mobile check at ~375px: open panel closes on crossing 768px; nothing renders below it.
- Run `pnpm --filter @dorkos/client typecheck`, `pnpm --filter @dorkos/client lint`, the four new test files individually via `pnpm vitest run`, then the full `pnpm verify` before opening the PR. Never substitute a bare `pnpm vitest run` for a full-suite check.
- Confirm no TODOs, no console warnings, and TSDoc on every export including module-level `@module` blocks.
