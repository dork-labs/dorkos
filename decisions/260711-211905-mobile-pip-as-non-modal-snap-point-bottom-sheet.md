---
id: 260711-211905
title: Mobile PIP presents as a non-modal snap-point bottom sheet
status: proposed
created: 2026-07-11
spec: pip-mobile-sheet
superseded-by: null
---

# 260711-211905. Mobile PIP presents as a non-modal snap-point bottom sheet

## Status

Proposed

## Context

The PIP panel shipped desktop-only (pip-panel ideation D2): below 768px the host rendered nothing and crossing the breakpoint force-closed the panel. With both consumers live (DOR-297 MCP Apps, DOR-298 gen-UI widgets), phones need a real PIP surface. The repo's mobile degradation convention is the vaul Drawer — but that convention is **modal**: an overlay dims and blocks the page. A modal sheet inverts PIP's purpose (stay glanceable while you work elsewhere); dismissing it would destroy the PIP, reducing it to "view once." Alternatives considered: a plain modal drawer (fails the purpose), and a modal drawer plus a persistent minimized pill (new store state, a novel UI element, and the pill shows no live content).

## Decision

Below 768px, `PipHost` swaps the presenter: the same serializable `PipContent` descriptor renders in a **non-modal vaul bottom sheet** (`modal={false}`, no overlay, `shouldScaleBackground={false}`) with two snap points (peek ≈ half screen, expanded ≈ 94%), opening at peek. The page behind stays fully interactive. Dragging below peek dismisses the sheet, which maps to `closePip` — safe because popped-out content is dual-live (the inline instance remains in the transcript). The sheet sits at `z-40`, deliberately below every modal surface (`z-50`). Content survives breakpoint crossings (the force-close effect is removed); the presenter swap remounts content, which the durable-stream replay and fence latching absorb. The modal-plus-pill variant is recorded as the contingency if vaul's non-modal mode proves unsound in validation.

## Consequences

### Positive

- True PIP on phones: the live board is visible at peek while the transcript above scrolls and taps normally.
- Zero changes to descriptors, store, renderers, bridge, or server — the presenter swap exercises exactly the seam the descriptor model was built for.
- Dismiss-as-close needs no new state because dual-live guarantees nothing is lost.
- A strict z-order rule (ambient `z-40` under modal `z-50`) keeps PIP from ever occluding dialogs, the mobile sidebar, or consent surfaces.

### Negative

- Non-modal + snap points is vaul's least-traveled configuration; it must be validated in the dev playground before feature work stacks on it (contingency recorded).
- The sheet closes without an exit animation in v1 (the host unmounts the branch when content clears); drag-down provides its own motion, but X-button closes are instant.
- Breakpoint crossings remount content: `widget` re-pins its stream (gap-free replay), `mcp_app` reloads its iframe.
