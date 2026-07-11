---
slug: pip-mobile-sheet
id: 260711-211617
created: 2026-07-11
status: specified
---

# Mobile PIP — dock the floating panel to a bottom sheet below 768px

**Status:** Approved
**Author:** Claude (flow SPECIFY, DOR-299)
**Date:** 2026-07-11

## Overview

Below the 768px breakpoint the PIP host currently renders nothing: pop-out affordances are hidden, and crossing the breakpoint force-closes an open panel. This spec replaces that gap with a mobile presenter: the same serializable `PipContent` descriptor renders inside a **non-modal, snap-point vaul bottom sheet** instead of the desktop `FloatingPanel`. A live tic-tac-toe board or MCP app stays glanceable at the peek snap while the app above remains fully interactive, expands for play, and drags down to dismiss. Descriptors, the store slice, content renderers, the MCP bridge, and all desktop behavior are untouched.

## Background / Problem Statement

DOR-296's ideation D2 deliberately scoped mobile out ("unavailable below 768px, follow-up DOR-299") with an explicit escape hatch: the content-descriptor model supports a different mobile presenter without rework. Both consumers have now shipped (DOR-297 MCP Apps pip mode, DOR-298 live gen-UI widgets), and the operator routed DOR-299 into `/flow`. The quality bar in AGENTS.md is explicit: every surface works on mobile, tablet, and desktop. Today a phone user who receives a live widget has no way to keep it visible while moving around the app.

## Goals

- PIP content works below 768px, presented as a bottom sheet with a glanceable peek state and an expanded play state.
- The app behind the sheet stays fully interactive (non-modal) — this is PIP, not a dialog.
- Pop-out affordances (WidgetFence, McpAppBlock) work on touch devices.
- An MCP app calling `requestDisplayMode('pip')` on a phone gets a working surface with zero bridge changes.
- Crossing the breakpoint in either direction swaps the presenter and keeps the content (no more force-close).
- Desktop behavior byte-for-byte unchanged.

## Non-Goals

- Snap-state or sheet-height persistence (geometry persistence remains desktop-only).
- Per-content-kind peek heights, landscape tuning, or a minimized-pill state (contingency only, see D3 in `01-ideation.md`).
- Keeping content **mounted** across a breakpoint crossing — the presenter swap remounts content (accepted: durable replay + the fence latch make `widget` seamless; `mcp_app` reloads its iframe, same cost as a pop-out).
- Obsidian embedded-mode guarantees (narrow panes inherit the sheet through the same seams; verified on web only).
- Multi-instance PIP, stacking, or restore-to-transcript (unchanged from the trio).

## Technical Dependencies

- `vaul@1.1.2` (already installed; `apps/client/package.json:83`) — `snapPoints`, `modal={false}`, `activeSnapPoint` control, `repositionInputs`. Docs: https://vaul.emilkowal.ski/
- `shared/ui/drawer.tsx` — the existing shadcn wrapper (all ten exports already in the shared/ui barrel).
- No new dependencies, no server changes.

## Detailed Design

### 1. `shared/ui/drawer.tsx` — overlay opt-out (the only shared/ui change)

`DrawerContent` gains one optional prop:

```tsx
const DrawerContent = React.forwardRef<
  React.ComponentRef<typeof DrawerPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DrawerPrimitive.Content> & {
    /**
     * Render the dimming overlay behind the sheet. Pass `false` for non-modal
     * sheets (`<Drawer modal={false}>`) where the page behind must stay
     * interactive and undimmed — e.g. the mobile PIP sheet.
     */
    overlay?: boolean;
  }
>(({ className, children, overlay = true, ...props }, ref) => (
  <DrawerPortal>
    {overlay && <DrawerOverlay />}
    <DrawerPrimitive.Content ...unchanged... >
```

Existing consumers pass nothing and keep the overlay. The z-index and `mt-24` in the base classes are overridden per-call-site through the existing `className` seam (`cn()` caller-last + tailwind-merge). The wrapper stays `forwardRef` (matching the file's existing style — the "no new forwardRef" rule applies to new components, and this is an edit to an existing one).

### 2. `features/pip-panel/ui/PipSheet.tsx` — the mobile presenter (new)

```tsx
interface PipSheetProps {
  content: PipContent; // non-null: the host only mounts the sheet while open
  onClose: () => void; // wired to closePip
  children: React.ReactNode; // renderPipContent(content) output
}
```

Composition (all primitives from the `@/layers/shared/ui` barrel — no direct vaul import in the feature):

```tsx
<Drawer
  open
  onOpenChange={(open) => { if (!open) onClose(); }}
  modal={false}
  shouldScaleBackground={false}
  snapPoints={SNAP_POINTS}
  activeSnapPoint={snap}
  setActiveSnapPoint={setSnap}
>
  <DrawerContent
    overlay={false}
    aria-label={content.title}
    className="z-40 mt-0 h-full max-h-[94%]"
  >
    {/* vaul handle renders from the wrapper (unchanged) */}
    <div className="flex items-center justify-between gap-2 border-b px-4 pt-1 pb-2">
      <DrawerTitle className="truncate text-sm font-medium">{content.title}</DrawerTitle>
      <button type="button" aria-label="Close" onClick={onClose} …>
        <X className="size-4" />
      </button>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>
  </DrawerContent>
</Drawer>
```

Pinned constants and behavior:

- `const SNAP_POINTS = [0.5, 0.94] as const` — **peek** (half screen: enough to show a full tic-tac-toe board on a typical phone) and **expanded**. `useState` initialized to `SNAP_POINTS[0]`: the sheet opens at peek. Snap state is component-local and intentionally resets to peek on every open (Non-Goal: no persistence).
- **Dismiss = close.** `dismissible` stays default (`true`); dragging below peek fires `onOpenChange(false)` → `closePip()`. Safe under the dual-live model — the inline instance still exists in the transcript.
- **Non-modal invariants:** `modal={false}`, `overlay={false}`, `shouldScaleBackground={false}`. The app behind stays interactive and undimmed. No focus trap.
- **z-order:** `z-40` — same ambient tier as the desktop `FloatingPanel`, deliberately **below** the mobile sidebar Sheet, dialogs, and command palette (all `z-50`). PIP never covers a modal surface.
- **Content sizing:** with snap points, vaul sizes the content to the largest snap and translates it down at peek — hence `h-full max-h-[94%]` (overriding the wrapper's `mt-24 h-auto` via tailwind-merge). The body region is `flex-1 min-h-0 overflow-y-auto`; `mcp_app` needs an explicit iframe height, which it gets from the same `h-full` adapter used on desktop (`McpAppPipContent` passes `className="h-full"` — in the sheet the body's flex sizing provides the resolved height). `widget` flows naturally; its empty state already assumes a filled container.
- `DrawerTitle` doubles as the accessible name (vaul/Radix wires `aria-labelledby`); the close button carries `aria-label="Close"`.
- No `DrawerDescription`: suppress the Radix missing-description warning with `aria-describedby={undefined}` on the content if it surfaces in tests (same approach as existing Sheet/Dialog call sites, verify at execute).

### 3. `PipHost.tsx` — presenter branch (replaces the mobile null-guard)

Restructure into three components in the same file (module scope, stable identities):

```tsx
export function PipHost() {
  const pipContent = useAppStore((s) => s.pipContent);
  const closePip = useAppStore((s) => s.closePip);
  const isMobile = useIsMobile();

  if (pipContent === null) return null;
  if (isMobile) {
    return (
      <PipSheet content={pipContent} onClose={closePip}>
        {renderPipContent(pipContent)}
      </PipSheet>
    );
  }
  return <DesktopPip content={pipContent} onClose={closePip} />;
}
```

- **`DesktopPip`** (new internal component, same file): absorbs today's desktop-only concerns verbatim — `pipGeometry`/`setPipGeometry` selectors, the `dockGeometry` state + resize-repin effect, `AnimatePresence` + `FloatingPanel key="pip-panel"` + the omitted-`onRestore` comment. Behavior is a pure lift-and-shift; the geometry hooks stop running on mobile entirely (they were previously called unconditionally above the null-return).
- **Deleted:** the close-on-cross effect (`PipHost.tsx:156-158`) and the `if (isMobile) return null` guard (line 161). Crossing the breakpoint now swaps presenters with content intact (ideation D2).
- **Exit animation asymmetry (accepted):** the desktop branch keeps its ~150ms `AnimatePresence` exit; the sheet unmounts on close without vaul's exit animation (vaul animates out only when `open` flips false while mounted — here the host unmounts the whole branch when `pipContent` goes null). v1 accepts the instant sheet close; the close gesture (drag-down) already provides its own motion. If polish demands it later, the sheet branch can latch content through the exit the same way `AnimatePresence` does for the panel.
- **Presenter-swap remount is by design** (Non-Goals): `widget` unpins → repins the stream (gap-free via `Last-Event-ID` replay; the fence latch prevents skeleton flicker), `mcp_app` refetches its resource.

### 4. Affordance guards — enable on touch

- **`WidgetFence.tsx:105`**: rendering gate `sessionId && !isMobile` → `sessionId` only, and drop the now-unused `useIsMobile` import/hook. Visibility classes change from `opacity-0 group-hover:opacity-100 focus-visible:opacity-100` to `opacity-100 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100` — always visible below `md` (no hover on touch), hover-reveal preserved at `md+`. Update the sibling comment (it currently cites the mobile null-host).
- **`McpAppBlock.tsx:~91`**: drop the `!isMobile` guard and the `useIsMobile` usage if now unused; the button is already always-visible. Update its comment.
- **`bridge.ts`**: no change — `pip` is advertised (line 29) and granted (line 137) unconditionally already.
- Both buttons keep `aria-label="Pop out into a floating window"`; the label stays accurate enough on mobile (the sheet is the floating surface) — copy stays.

### 5. Dev playground

`PipPanelShowcases.tsx` gains a mobile note + the validation surface for the non-modal snap-point mechanics (ideation D8): the existing demo-open button exercises the sheet when the viewport is narrow. Playground validation of vaul `modal={false}` + `snapPoints` + no-overlay is **implementation task 1** — if vaul misbehaves (drag jank, pointer-events leakage onto the page, body scroll lock engaging despite non-modal), stop and re-plan against the recorded contingency (modal + minimized pill) before building on top.

### Code structure & file organization

| File                                          | Change                                                           |
| --------------------------------------------- | ---------------------------------------------------------------- |
| `layers/shared/ui/drawer.tsx`                 | `overlay?: boolean` opt-out on `DrawerContent`                   |
| `layers/features/pip-panel/ui/PipSheet.tsx`   | **new** — mobile presenter                                       |
| `layers/features/pip-panel/ui/PipHost.tsx`    | presenter branch; `DesktopPip` extraction; delete close-on-cross |
| `layers/features/pip-panel/index.ts`          | unchanged public API (`PipHost` only; `PipSheet` stays internal) |
| `layers/features/gen-ui/ui/WidgetFence.tsx`   | drop `!isMobile` gate; touch-visible button classes              |
| `layers/features/mcp-apps/ui/McpAppBlock.tsx` | drop `!isMobile` gate                                            |
| `src/dev/showcases/PipPanelShowcases.tsx`     | mobile validation note                                           |
| `docs/` (guides touched by the trio)          | one honest sentence: PIP now works on phones as a bottom sheet   |

### API / data model changes

None. `PipContent`, the pip slice, `Transport`, and the server are untouched.

## User Experience

1. **Pop out (widget):** on a phone, an interactive board in the transcript shows the pop-out button (always visible — no hover on touch). Tap → the bottom sheet slides up to half screen with the live board inside. The transcript above remains scrollable and tappable.
2. **Glance & play:** the sheet shows the board at peek. Drag the handle up → expands to 94% for comfortable play. Taps dispatch exactly as inline (same `WidgetFence` pipeline: latch, optimistic `ui_action`, pending, celebrations).
3. **Navigate:** switch sessions or pages (client-side) — the sheet persists and the board keeps updating (pinned background stream, unchanged from DOR-298).
4. **Dismiss:** drag down past peek, or tap the X → sheet closes, content cleared. The inline board is still in the transcript.
5. **MCP app:** tapping pop-out on an MCP app block (or the app requesting `pip`) opens the same sheet hosting the app frame.
6. **Breakpoint crossing:** resizing/rotating across 768px swaps float ↔ sheet with the same content; a `widget` board reappears live (brief remount, no data loss), an `mcp_app` reloads.
7. **Error/edge paths:** no session id → no pop-out button (unchanged); empty widget session → the existing "No live widget in this session" state inside the sheet.

## Testing Strategy

jsdom cannot exercise vaul's gesture/snap mechanics — those are covered by the playground validation task and the VERIFY-stage live browser proof at a mobile viewport. Unit tests cover everything structural:

- **`PipHost` branching** (`features/pip-panel/__tests__/PipHost.test.tsx`, extend): mocked `useIsMobile` true → sheet presenter renders (assert by `data-slot`/role, not vaul internals); false → `FloatingPanel` path renders; content **survives** an `isMobile` flip in both directions (regression on the deleted close-on-cross effect — assert `pipContent` still set and the other presenter mounted); `pipContent === null` renders nothing in both modes.
- **`PipSheet`**: renders title + content children; X button calls `onClose`; `onOpenChange(false)` path calls `onClose`. (vaul renders fine in jsdom — `AgentsPage.test.tsx` already tests a Drawer; reuse its setup patterns, including any pointer-capture/matchMedia shims.)
- **`DrawerContent` overlay opt-out** (`shared/ui/__tests__/`): `overlay={false}` renders no overlay element; default renders one. Existing consumers' tests stay green (prop is additive).
- **`WidgetFence`** (extend existing tests): pop-out button now renders when `isMobile` is true (update the old hidden-on-mobile assertion to the inverse); still absent without `sessionId`.
- **`McpAppBlock`** (extend): pop-out present on mobile.
- **E2E/browser (VERIFY stage, not CI):** Playwright at 390×844 — pop out a live widget, background interactivity at peek, expand, play a move from the sheet, client-side navigate away and back, drag-dismiss, and a breakpoint-crossing resize both directions.

## Performance Considerations

Negligible: one additional conditional branch in the host; the sheet mounts only while PIP is open on mobile. The geometry resize listener stops running on mobile (small win). No new subscriptions; the pinned-stream budget (≤3 connections) is unchanged.

## Security Considerations

None new: same content renderers, same MCP consent flow inside `McpAppFrame`, no new data paths. Non-modal means the sheet never blocks security-relevant dialogs (they sit at `z-50`, above it).

## Documentation

- `docs/guides/generative-ui.mdx` + `docs/integrations/mcp-server.mdx`: update the one-line PIP mentions to include phones ("on phones it docks as a bottom sheet"). Plain language per `writing-for-humans`.
- Changelog fragment (one, plain-language) in `changelog/unreleased/`.

## Implementation Phases

- **Phase 1 — mechanics validation:** DrawerContent overlay opt-out + PipSheet skeleton + playground validation of non-modal snap behavior (gate: proceed only if sound).
- **Phase 2 — host integration:** PipHost presenter branch, DesktopPip extraction, delete close-on-cross; unit tests.
- **Phase 3 — affordances + polish:** WidgetFence/McpAppBlock guards, docs, changelog, showcase note.

## Open Questions

~~Q1: Should the sheet expose vaul's exit animation on close?~~ **(RESOLVED)** Answer: no — accept instant unmount for v1. Rationale: the dominant close path is drag-down, which carries its own motion; wiring exit latching adds state for marginal polish (Detailed Design §3).

~~Q2: Controlled vs uncontrolled snap point?~~ **(RESOLVED)** Answer: controlled with component-local state, initial peek. Rationale: deterministic open-at-peek on every open and a seam for tests; uncontrolled first-snap default would also work but hides the reset-on-open contract.

## Related ADRs

- `decisions/260711-150550-cockpit-native-pip-panel-over-document-pip-api.md` — the panel is cockpit-native, which is what makes a presenter swap possible at all.
- `decisions/260711-150551-pip-content-descriptors-routed-by-host-feature.md` — the descriptor model this feature exercises.
- `decisions/260711-175416-pip-liveness-via-pinned-background-stream-slot.md` — why the sheet's live widget survives navigation.
- **New (this spec):** mobile PIP presents as a non-modal snap-point bottom sheet (extracted at SPECIFY).

## References

- Linear DOR-299; specs `pip-panel`, `gen-ui-pip`; PRs #241/#244/#245 (the trio).
- vaul docs (snap points, non-modal): https://vaul.emilkowal.ski/
- `contributing/design-system.md` (Calm Tech), `.claude/rules/components.md`.
