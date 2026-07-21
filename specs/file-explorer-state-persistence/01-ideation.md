# File explorer state persistence + UX polish — Ideation

**Issue:** DOR-404 · **Date:** 2026-07-21 · **Origin:** direct operator request

## The problem

The right-panel file explorer (Files tab) loses all of its state whenever it unmounts.
The killer scenario, verbatim from the operator: navigate deep into the tree, open a
file (which switches the panel to the Canvas tab), close the file, return to Files —
the tree has collapsed back to the root. Opening a second file from the same directory
means re-navigating from scratch. State also dies on page refresh.

## Root cause (from implementation research)

- `RightPanelContainer` renders exactly one active tab component (`{ActiveComponent ? <ActiveComponent/> : null}`);
  switching tabs fully unmounts the previous tab.
- Opening a file runs `executeUiCommand('open_file')` → `revealCanvas()` →
  `setActiveRightPanelTab('canvas')` — i.e. **every explorer file-open unmounts the explorer**.
- All tree state is component-local: `expanded`/`loaded`/`childrenByPath` in a `useReducer`
  inside `useFileExplorer`; `selectedPath`/`renamingPath`/`draft` in `useState` in
  `FileExplorer.tsx`. Nothing external retains it. Directory listings are fetched
  imperatively via `transport.readFileTree` (no TanStack Query), so there is no data
  cache either — every remount refetches root and forgets everything else.

Meanwhile the two adjacent slices already solve this correctly: canvas documents
(`app-store-canvas.ts`, persisted per session) and the active right-panel tab
(`app-store-right-panel.ts`, persisted per agent) both survive tab switches and reloads.
The explorer is the odd one out.

## Convention research (what "consistent" means here)

From the state-persistence survey of the whole client:

- **Zustand `persist` middleware is used nowhere.** The unbroken convention is
  hand-written `readX`/`writeX` localStorage helpers (try/catch), called inline from
  store actions — see `app-store-helpers.ts` (canvas sessions, right-panel layouts,
  bool preferences) and the frecency store's `useSyncExternalStore` variant.
- **Scoped persisted state = one JSON blob per concern**, a `Record<scopeKey, Entry>`
  map with an `accessedAt` LRU cap of 50 (`MAX_CANVAS_SESSIONS`, `MAX_RIGHT_PANEL_LAYOUTS`).
- **Hydration is explicit** (`loadCanvasForSession`, `loadRightPanelForAgent`), never
  automatic.
- **Server config (`ui.*`) is reserved for cross-device data** (DOR-329 sidebar org) and
  its write path (`updateConfig`) is a **no-op in Obsidian embedded mode** — so it is the
  wrong home for local navigation ergonomics.
- **URL search params are reserved for "the address"** (session, dir, dialog deep links) —
  expansion/scroll state would churn the URL on every click; explicitly against convention.
- **Server state belongs in TanStack Query** (`contributing/state-management.md` decision
  matrix). The explorer's imperative fetching is a documented inconsistency: the file
  _content_ viewer, the workspace badge, and the older flat-file picker (`features/files`)
  all already use TanStack Query with `QUERY_TIMING` constants.
- **Never write localStorage per-frame** (PIP geometry rule) — scroll persistence must be
  debounced/gesture-scoped.

## Options considered

1. **Keep-alive the Files tab** (render hidden instead of unmounting).
   Rejected: changes `RightPanelContainer` semantics for all five tabs, holds DOM/memory
   for panels that may never be revisited, doesn't survive refresh anyway, and cuts
   against the Inspector architecture (research 20260720: fixed shell, swappable body).
2. **Persist to server config (`ui.*`)** like sidebar groups.
   Rejected: broken in embedded mode, heavier write path, and this is per-machine
   navigation ergonomics, not cross-device organizational data (the state-management
   doc's own dividing line).
3. **Lift UI state into the feature's Zustand store with per-cwd localStorage persistence,
   and move directory data into TanStack Query.** Chosen — it is exactly the pattern the
   canvas and right-panel slices already use, fixes the data-layer inconsistency, and
   makes refresh/caching behavior fall out for free.

## Decisions (with rationale)

| #   | Decision                                                                                                                                                    | Rationale                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Persist expanded/selection/scroll in the **feature-owned Zustand store**, localStorage blob `Record<cwd, Entry>`, LRU 50, explicit hydration action         | Mirrors canvas/right-panel exactly; feature-scoped per Marketplace precedent                                                                                        |
| D2  | **Scope key = `cwd`**                                                                                                                                       | The tree represents a directory, not a conversation; `useFileExplorer(cwd)` is already keyed this way; two sessions in one cwd sharing tree state is correct        |
| D3  | **Directory listings move to TanStack Query** (per-directory keys)                                                                                          | Server state per the decision matrix; cache survives remounts; subtree refresh = one `invalidateQueries`; consistent with `canvas-file`/`workspace`/`files` queries |
| D4  | Refresh button invalidates the **whole expanded subtree**, not just root                                                                                    | Fixes a real staleness bug found in research                                                                                                                        |
| D5  | `showHidden` becomes persisted (global, bool helper convention)                                                                                             | It already survives tab switches only by accident of module scope; refresh loses it                                                                                 |
| D6  | Scroll restore: debounced write + write-on-unmount; restore once after first data render                                                                    | The PIP "never per-frame" rule                                                                                                                                      |
| D7  | `renamingPath`/`draft` stay component-local                                                                                                                 | Dialog-scoped/ephemeral state must reset (anti-pattern list)                                                                                                        |
| D8  | Out of scope, captured as follow-ups: tree search/filter, multi-select, copy/duplicate, reveal-from-canvas for agent-opened files, committed Playwright e2e | Each deserves its own design; keeps this PR reviewable                                                                                                              |

## Assumption trail

- A1: Persisting per-cwd (not per-agent-key) is acceptable; the right panel's agent-key
  resolution exists but the explorer's identity is the directory itself. Reversible later
  by swapping the scope-key function.
- A2: No config-schema change → no migration needed; localStorage-only.
- A3: Stale persisted paths (deleted dirs) are pruned lazily when a parent listing loads;
  harmless if never loaded.
