# pip-mobile-sheet — task breakdown

Generated 2026-07-11 from `02-specification.md` (full mode). Canonical data: `03-tasks.json`.

## Phase 1 — Sheet mechanics

### Task 1.1: Add overlay opt-out to DrawerContent

`shared/ui/drawer.tsx`: optional `overlay?: boolean` (default `true`) on `DrawerContent`; `false` skips `<DrawerOverlay />`. Keep forwardRef (existing file style). Unit tests: overlay present by default, absent when opted out, children render, existing consumers green.

### Task 1.2: Build PipSheet, the mobile PIP presenter

New `features/pip-panel/ui/PipSheet.tsx` — non-modal vaul sheet composed only from the shared/ui barrel. `snapPoints [0.5, 0.94]`, opens at peek (component-local controlled snap state), `modal={false}` + `overlay={false}` + `shouldScaleBackground={false}`, `z-40 mt-0 h-full max-h-[94%]`, header (truncated title + X close), scrollable body. Dismiss (drag below peek / X) → `onClose`. Unit tests: title/children render, X → onClose, `onOpenChange(false)` → onClose. (depends: 1.1)

### Task 1.3: GATE — validate vaul non-modal snap mechanics in the playground

Browser check at ~390×844 via the dev playground: peek open, background interactive, expand, drag-dismiss, no scaling, content taps. Any unfixable failure → STOP and re-plan against the modal+minimized-pill contingency. (depends: 1.2, 2.1)

## Phase 2 — Host integration

### Task 2.1: Presenter branch in PipHost + DesktopPip extraction

`PipHost` routes: null → nothing; mobile → `PipSheet`; desktop → new internal `DesktopPip` (verbatim lift of geometry state/effects + AnimatePresence + FloatingPanel; preserve the always-mounted AnimatePresence contract for the exit animation). Delete the close-on-cross effect and the mobile null-guard. Tests: presenter per mode, content survives breakpoint flips both directions, null renders neither, desktop geometry tests unchanged. (depends: 1.2)

## Phase 3 — Affordances + polish (parallel)

### Task 3.1: Enable WidgetFence pop-out on touch

Gate drops `!isMobile`; button always visible below `md`, hover-reveal at `md+` (`opacity-100 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100`); comment + tests updated. (depends: 2.1)

### Task 3.2: Enable McpAppBlock pop-out on mobile

Drop the `!isMobile` guard (button already always-visible); comment + tests updated; no bridge changes. (depends: 2.1)

### Task 3.3: Docs, changelog fragment, showcase note

One plain-language sentence in each of the two docs pages; one changelog fragment (timestamp id, consolidate any populator stub); mobile note in `PipPanelShowcases`. (depends: 2.1)

## Critical path

1.1 → 1.2 → 2.1 → {3.1 ∥ 3.2 ∥ 3.3} → 1.3 (browser gate) → batch verification (`pnpm --filter @dorkos/client typecheck && lint`, targeted vitest, full `pnpm test -- --run` at the end).

No task reaches the sub-issue threshold (all small/medium) — everything stays checklist-only.

## Phase 4 — Minimize model (Amendment 2, incremental decompose 2026-07-11)

### Task 4.1: Minimized mini-bar state + layout dock hook

Three-state mobile model per Amendment 2: `pipMinimized` store flag, `PipMiniBar` (64px docked bar, restore/close), PipSheet drag-below-peek remapped to minimize + chevron button, `--pip-dock` padding hook consumed by both shells, desktop-to-mobile crossing lands minimized. (depends: 2.1)
