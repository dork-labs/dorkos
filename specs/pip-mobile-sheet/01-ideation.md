---
slug: pip-mobile-sheet
created: 2026-07-11
status: ideation
---

# Mobile PIP — dock the floating panel to a bottom sheet below 768px

**Slug:** pip-mobile-sheet
**Author:** Claude (flow IDEATE, DOR-299)
**Date:** 2026-07-11
**Tracker:** DOR-299 - Mobile PIP: dock the floating panel to a bottom sheet below 768px

---

## 1) Intent & Assumptions

- **Task brief:** The floating PIP panel (DOR-296) is deliberately unavailable below 768px in v1: pop-out affordances are hidden and an open panel closes when the viewport crosses the breakpoint. Now that both consumers shipped (DOR-297 MCP Apps, DOR-298 live gen-UI widgets), give phones a real PIP surface: dock PIP content into a bottom sheet (vaul Drawer, the repo's established mobile degradation convention) so a live widget or MCP app stays glanceable — and playable — on a phone while the operator moves around the app.
- **Assumptions:**
  - The PIP trio is merged and the content-descriptor model holds: `PipContent` is serializable, renderers are routed by `PIP_RENDERERS` at module scope, and the host is the only component that knows how content is presented (`PipHost.tsx`). Swapping the presenter below the breakpoint requires **zero** changes to descriptors, store, or content renderers.
  - `vaul@1.1.2` is installed with a shadcn wrapper at `shared/ui/drawer.tsx`, and the Drawer-below-768px convention is live in five features (tasks AgentPicker, feature-promos, status, command-palette, agents).
  - Mobile navigation is a Sheet-overlay sidebar (`shared/ui/sidebar.tsx:180`), not a bottom tab bar — the bottom edge is free for a sheet.
- **Out of scope:**
  - Snap-state persistence across close/reopen (geometry persistence stays desktop-only).
  - Per-content-kind peek heights or landscape tuning.
  - A "minimized pill" state (see D3 contingency — recorded, not built).
  - Obsidian embedded mode guarantees: a narrow Obsidian pane (<768px) will inherit the sheet presenter through the same seams; verified on web only (demo-claim gate).
  - Desktop behavior: byte-for-byte unchanged.

## 2) Pre-reading Log

- Linear DOR-299 description — the staging condition ("wait until at least one consumer ships") is met; operator routed it into `/flow` 2026-07-11.
- `specs/pip-panel/01-ideation.md` D2 — the original mobile-unavailable decision this supersedes, and its explicit escape hatch: "the panel's content-descriptor model already supports a different mobile presenter without rework."
- Consumer discovery sweep (this flow run, verified with line refs):
  - `PipHost.tsx:122-186` — the mobile guard (`if (isMobile) return null`, line 161) and the close-on-cross effect (lines 156-158) are the two things this feature removes. The default-dock geometry state and reclamp wiring are desktop-branch-only concerns.
  - `use-is-mobile.ts` — `MOBILE_BREAKPOINT = 768`, matchMedia-driven; the exact signal the presenter branch keys on.
  - `WidgetFence.tsx:105-118` — pop-out gated `sessionId && !isMobile`; the button is `opacity-0 group-hover:opacity-100`, i.e. **invisible on touch even if unhidden** — mobile needs an always-visible treatment.
  - `McpAppBlock.tsx:~91` — pop-out gated `!isMobile`; the button is otherwise always visible, so this guard just drops.
  - `mcp-apps/model/bridge.ts:29,137` — `pip` is advertised and granted unconditionally; **no bridge change needed** — an MCP app's `requestDisplayMode('pip')` on a phone starts working the moment the host renders there.
  - `shared/ui/drawer.tsx` — `DrawerContent` hardcodes overlay + `z-50` + `mt-24` + drag handle; the Root wrapper defaults `shouldScaleBackground = true`. All ten Drawer exports are in the shared/ui barrel.
  - `LiveSessionWidget.tsx` — pin/unpin lifecycle is a mount-scoped effect; content is auto-height (`WidgetFence` flows), empty state assumes `h-full` from its container.
  - `PipHost.tsx:44-67` — `McpAppPipContent` passes `className="h-full"`; in a sheet the content region must supply an explicit height for the iframe case.
- `session-stream-store` / `stream-manager` (DOR-298) — unpin→repin across a remount closes and reopens the pinned connection when off-route, but the durable stream protocol (`Last-Event-ID` replay) makes the reconnect gap-free; `WidgetFence` latches the last parsed document, so the board never flickers to a skeleton across it.

## 3) Codebase Map

- **New presenter:** `features/pip-panel/ui/PipSheet.tsx` — the mobile bottom-sheet chrome (vaul via shared/ui Drawer primitives): handle, title header, close button, snap points, content region. Renders the same `renderPipContent(content)` output as the desktop branch.
- **Host branch:** `PipHost.tsx` — replace `if (isMobile) return null` + close-on-cross effect with a presenter branch: mobile → `PipSheet`, desktop → `FloatingPanel` (unchanged). Geometry state/effects stay scoped to the desktop branch.
- **Shared primitive touch:** `shared/ui/drawer.tsx` — `DrawerContent` gains an opt-out for the overlay (non-modal use); everything else overrides via the existing `className` seam.
- **Affordances:** `WidgetFence.tsx` (drop `!isMobile`, add touch-visible button treatment), `McpAppBlock.tsx` (drop `!isMobile`).
- **Blast radius:** pip-panel (presenter), shared/ui (drawer opt-out), gen-ui + mcp-apps (affordance guards). No store changes, no bridge changes, no server changes, no new dependencies.

## 4) Root Cause Analysis

Not a bug fix — omitted.

## 5) Research

**The one hard problem — glanceable vs modal.** The repo's Drawer convention is modal (overlay, background blocked). A modal sheet contradicts PIP's purpose: dismiss would mean close, so "glance at the game" becomes open → look → gone. Three options:

1. **Modal drawer (plain convention):** simplest; but the background is inert while open and drag-down-to-dismiss destroys the PIP (content cleared). PIP degenerates into "view once."
2. **Non-modal snap-point drawer (recommended):** `modal={false}`, no overlay, `shouldScaleBackground={false}`, `snapPoints` [peek, expanded]. At peek the sheet occupies the lower part of the screen while the app above stays fully interactive — a true mobile PIP. Drag up to play, drag down past peek to dismiss (= `closePip`, safe: the inline instance still exists per DOR-298's dual-live model). vaul 1.1.2 supports the combination; it is the least-traveled vaul configuration, so it must be validated in the dev playground **before** the feature work stacks on it.
3. **Modal drawer + minimized pill:** a floating mini-pill (title + live dot) that expands into a modal drawer. Adds a new store state (`pipMinimized`) and a novel UI element; the pill shows no board, so it is less glanceable than option 2's peek. Held as the **contingency** if vaul's non-modal mode proves broken in validation.

**Recommendation:** Option 2, with option 3 recorded as fallback.

**Interaction conflicts in the sheet:** tic-tac-toe and checklists are tap-only — taps pass through vaul cleanly. Text inputs (form widgets) summon the keyboard; vaul's `repositionInputs` handles the viewport shift. Iframes (`mcp_app`) swallow pointer events, so sheet drag must work from the handle/header — which vaul supports natively; content-area drag over an iframe simply doesn't move the sheet (acceptable).

**Presenter-swap remount:** crossing 768px swaps FloatingPanel ↔ PipSheet, unmounting content. For `widget` this unpins and repins the stream; durable replay + the fence latch make it visually seamless. For `mcp_app` the iframe reloads (MCP Apps re-fetch their resource — same cost as a pop-out). Accepted for v1; keeping content mounted across presenters (a shared portal container) is real complexity for a rare gesture (window resize / tablet rotation).

## 6) Decisions

| #   | Decision                    | Choice                                                                                                                                                                                                                             | Rationale                                                                                                                                     |
| --- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Architecture                | Presenter swap inside `PipHost`: mobile → new `PipSheet`, desktop → `FloatingPanel` unchanged; descriptors, store, renderers, bridge untouched                                                                                     | The content-descriptor model was designed for exactly this (pip-panel D2's escape hatch); zero rework anywhere else                           |
| D2  | Breakpoint crossing         | Content **survives**: remove the close-on-cross effect; the same descriptor re-renders in the other presenter. Geometry stays desktop-only. Content remounts across the swap (accepted, §5)                                        | Rotating a tablet or resizing a window must not kill a live game; the store is presenter-agnostic                                             |
| D3  | Sheet mechanics             | Non-modal vaul Drawer: `modal={false}`, no overlay, `shouldScaleBackground={false}`, `snapPoints` ≈ [0.5, 0.92] (spec pins exact values), opens at peek, drag below peek dismisses = `closePip`. Contingency: option 3 (§5)        | Glanceable requires the app behind to stay interactive; dismiss-as-close is safe under dual-live. Validate vaul non-modal in playground first |
| D4  | Sheet chrome                | vaul handle + header row (truncated title, X close button), content region with explicit height budget (`mcp_app` iframe needs it; `widget` flows with a min-height). `z-40` — below the mobile sidebar Sheet and dialogs (`z-50`) | PIP is ambient, never above modal surfaces; matches FloatingPanel's z tier                                                                    |
| D5  | Affordances on mobile       | Drop both `!isMobile` guards. `McpAppBlock`'s button is already always-visible. `WidgetFence`'s hover-reveal button becomes always-visible below the breakpoint (hover-reveal stays desktop-only)                                  | No hover on touch — an unhidden but hover-gated button would still be invisible                                                               |
| D6  | Shared drawer change        | `DrawerContent` gains a minimal overlay opt-out (e.g. `overlay?: boolean`, default `true`); z/margin overrides ride the existing `className` seam                                                                                  | Keeps all vaul composition in shared/ui (no direct vaul import in a feature); existing consumers untouched                                    |
| D7  | Bridge & `demo` kind        | No bridge change (`pip` already granted unconditionally); `demo` works in the sheet with no special-casing                                                                                                                         | Verified at `bridge.ts:137`; the host was the only missing piece on mobile                                                                    |
| D8  | Validation-first sequencing | The vaul non-modal + snapPoints combination is validated in the dev playground (showcase) as the first implementation task, before feature work stacks on it                                                                       | It is the load-bearing novel mechanism; if it fails, the contingency (D3) changes the shape of everything downstream                          |

**Next step:** move to SPECIFY. The spec must pin: exact snap points and defaults, the `PipSheet` prop/chrome contract, the DrawerContent opt-out API, the WidgetFence mobile visibility treatment, z-order rules, and the test plan (unit for host branching + affordance guards; the vaul mechanics are playground/browser-verified since jsdom can't exercise them).
