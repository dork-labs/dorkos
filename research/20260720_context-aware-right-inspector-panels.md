# Context-aware right-side inspector panels — how leading tools split global vs. contextual content

**Date:** 2026-07-20 · **Method:** primary-source review of VS Code, JetBrains, Linear, Figma, Notion, Chrome DevTools + Side Panel API, Raycast · **Feeds:** the right-panel "Cockpit Inspector" redesign (retiring `sidebar.tabs`).
Complements (does not overlap): `20260328_multi_panel_toggle_ux_patterns.md` (toggle mechanics), `20260310_sidebar_tabbed_views_ux.md`, `20260320_dashboard_route_navigation_architecture.md`.

## The one-line convergence

Every mature tool ships a **fixed panel shell** (chrome, tabs, toggle — never route-hidden) wrapping **swappable content** split at the _section/view_ level, never at the panel level — and every one of them engineers explicitly against the same failure mode: **the dead panel** (open, but nothing meaningful to show).

## Per-tool key findings

- **VS Code — Secondary Side Bar**: a generic container; content is user/extension-placed Views in View Containers (3–5 views max per container; `...` overflow beyond). Avoids emptiness by _not showing the panel_ in an empty window (`workbench.secondarySideBar.defaultVisibility`). Sources: code.visualstudio.com/docs/configure/custom-layout, /api/ux-guidelines/sidebars.
- **JetBrains — right tool windows**: the global-vs-contextual decision is delegated to the user per tool window via pin modes (Dock Pinned = behaves global; Unpinned/Undock = contextual-by-attention). The always-visible icon rail is the cheap permanent spine. Sources: jetbrains.com/help/idea/tool-windows.html, /viewing-modes.html.
- **Linear**: issue sidebar = a _stack of typed property rows_ (state), never tabs; **activity/history deliberately lives outside the panel** as a stream. Peek (`Space`) is a metadata-only preview that excludes comments — a considered state-vs-history split. Source: linear.app/docs/peek.
- **Figma — the clearest pattern ("swap the payload, keep the frame")**: with nothing selected, the Design tab shows _file-global_ content (styles, variables, canvas); select a layer and the same tab's whole body swaps to layer properties. The panel is never empty because **global content is promoted to fill the no-selection state**. UI3's coupling of left/right panel visibility is a community-contested regression — independent visibility wins. Sources: help.figma.com (right sidebar, inspecting), forum.figma.com feature request.
- **Notion — three formally named property tiers**: Pinned (≤15, always visible) / Groups (collapsible in body) / Panel (hidden by default, opt-in), with a strict non-overlap routing rule. Its documented anti-pattern is toggle proliferation (4 inconsistent ways to close the panel). Source: notion.com/help/layouts.
- **Chrome Side Panel API — the global/contextual split formalized in code**: `default_path` = global panel on every tab; `setOptions({tabId,...})` = per-tab contextual panel that **wins when present, with the global panel as fallback** — never an empty result. This fallback rule is directly reusable. Source: developer.chrome.com/docs/extensions/reference/api/sidePanel.
- **DevTools**: two-level hierarchy (outer tool tabs → inner contextual panes); Firefox shows explicit "No element selected", Chrome default-selects a node to avoid the empty state entirely.
- **Raycast — `Detail.Metadata`**: metadata is a typed stack of rows (Label/TagList/Link/Separator) and is _optional at the API level_ — omitted entirely rather than rendered empty.

## Synthesized principles (for the DorkOS right panel)

1. **Split by availability, not by fixed buckets**: contextual content wins when present; global content is the fallback that fills the space — the panel is never empty (Chrome's rule, Figma's behavior).
2. **Hybrid structure wins**: low-cardinality outer tabs (rarely changing) containing stacked/collapsible capped sections. Leaf-level tabs only for multiple views of the _same_ data (DevTools Styles/Computed). Tab proliferation is the Notion failure.
3. **Empty states, ranked**: (best) promote global content into the no-selection state → (ok) default-select something sensible → (weak) "nothing selected" caption. For a persistent cockpit inspector, promote-global is the fit.
4. **The shell is never route-hidden** — only the body varies. An always-visible toggle is load-bearing infrastructure (corroborated by the Cursor toggle-removal bug reports in prior research).
5. **Cap the always-visible set** (Notion's ≤15 pins, VS Code's 3–5 views); overflow beyond a small fixed count rather than growing unbounded.
6. **Keep panel visibility independent** per surface (Figma's UI3 coupling is the contested outlier).
7. **State vs. history**: current state belongs in the panel as typed rows; chronological history reads better as a stream surface (Linear's deliberate split) — an activity _peek_ in a panel should be a capped teaser linking out, not the full feed.

## Gaps

Height (acquired/sunset 2023) undocumented; Arc's sidebar is a left-side workspace organizer, not a contextual inspector (Chrome's Side Panel API substituted); Notion's tier _rationale_ inferred from mechanics; Figma UI3 regression sourced from community forum, not changelog.
