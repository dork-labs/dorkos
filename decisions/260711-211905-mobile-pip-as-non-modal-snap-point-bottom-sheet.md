---
id: 260711-211905
title: Mobile PIP presents as a non-modal snap-point bottom sheet
status: accepted
created: 2026-07-11
spec: pip-mobile-sheet
superseded-by: null
---

# 260711-211905. Mobile PIP presents as a non-modal snap-point bottom sheet

## Status

Accepted

## Context

The PIP panel shipped desktop-only (pip-panel ideation D2): below 768px the host rendered nothing and crossing the breakpoint force-closed the panel. With both consumers live (DOR-297 MCP Apps, DOR-298 gen-UI widgets), phones need a real PIP surface. The repo's mobile degradation convention is the vaul Drawer — but that convention is **modal**: an overlay dims and blocks the page. A modal sheet inverts PIP's purpose (stay glanceable while you work elsewhere); dismissing it would destroy the PIP, reducing it to "view once." Alternatives considered: a plain modal drawer (fails the purpose), and a modal drawer plus a persistent minimized pill (new store state, a novel UI element, and the pill shows no live content).

## Decision

Below 768px, `PipHost` swaps the presenter: the same serializable `PipContent` descriptor renders in a **non-modal bottom sheet** with two snap points (peek ≈ half screen, expanded ≈ 94%), opening at peek. The page behind stays fully interactive. Dragging below peek dismisses the sheet, which maps to `closePip` — safe because popped-out content is dual-live (the inline instance remains in the transcript). The sheet sits at `z-40`, deliberately below every modal surface (`z-50`). Content survives breakpoint crossings (the force-close effect is removed); the presenter swap remounts content, which the durable-stream replay and fence latching absorb.

The sheet is **cockpit-native** — a `createPortal`'d, `motion`-driven div with hand-rolled snap and dismiss gestures, the same philosophy as the desktop `FloatingPanel` (ADR 260711-150550) — **not** a vaul Drawer. vaul was the planned mechanism (this ADR's original form) but failed the validation gate: `vaul@1.1.2` never forwards `modal` to its underlying Radix Dialog Root, so Radix runs fully modal and applies `aria-hidden` to the entire app behind the sheet — a screen-reader blackout that contradicts non-modality. It is unfixable via props (verified in vaul's dist), and stripping the attributes by hand desyncs Radix's `hideOthers` counter bookkeeping the moment a real modal (the mobile sidebar Sheet, any dialog) stacks above the open sheet and closes. The modal-plus-pill contingency was rejected too: it abandons the glanceable contract the feature exists for. Spec amendment: `specs/pip-mobile-sheet/02-specification.md` Amendment 1.

## Consequences

### Positive

- True PIP on phones: the live board is visible at peek while the transcript above scrolls and taps normally.
- Zero changes to descriptors, store, renderers, bridge, or server — the presenter swap exercises exactly the seam the descriptor model was built for.
- Dismiss-as-close needs no new state because dual-live guarantees nothing is lost.
- A strict z-order rule (ambient `z-40` under modal `z-50`) keeps PIP from ever occluding dialogs, the mobile sidebar, or consent surfaces.

### Negative

- Hand-rolled gestures mean we own the snap/dismiss physics and forgo vaul's platform niceties (keyboard input repositioning, iOS rubber-banding); acceptable for tap-first PIP content, revisit if form-heavy widgets land.
- The sheet closes without an exit animation in v1 unless the host's mobile branch wraps it in `AnimatePresence`; drag-down provides its own motion either way.
- Breakpoint crossings remount content: `widget` re-pins its stream (gap-free replay), `mcp_app` reloads its iframe.
