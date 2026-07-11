# Implementation Summary: Mobile PIP — bottom sheet below 768px

**Created:** 2026-07-11
**Last Updated:** 2026-07-11
**Spec:** specs/pip-mobile-sheet/02-specification.md
**Tracker:** DOR-299

## Summary

Below 768px the PIP host now presents the same serializable `PipContent`
descriptor in a cockpit-native, non-modal snap-point bottom sheet (`PipSheet`)
with a minimized mini-bar state (`PipMiniBar`), instead of rendering nothing.
Pop-out affordances (`WidgetFence`, `McpAppBlock`) work on touch, breakpoint
crossings swap presenters with content intact, and desktop behavior is
unchanged. Shipped as one commit across all seven tasks plus two mid-execute
amendments:

- **Amendment 1 (mechanism swap):** the spec's original vaul composition was
  rejected at the Phase-1 validation gate — vaul@1.1.2 never forwards `modal`
  to its Radix Dialog Root, so Radix runs fully modal and applies
  `aria-hidden="true"` to `#root`, removing the entire app from assistive
  technology behind a supposedly non-modal sheet. Not fixable with props;
  attribute-stripping would desync Radix's hideOthers bookkeeping under
  stacked modals. The sheet became a plain portalled `motion.div` mirroring
  `FloatingPanel` (same `role="complementary"` semantics, no portal-modality
  machinery). The `DrawerContent` overlay opt-out shipped for the vaul
  composition was reverted (no consumer, no dead code).
- **Amendment 2 (minimize model, operator UX review):** at peek the sheet
  occludes a chat surface's two highest-value zones (composer + newest
  messages), and dismiss meant close. Resolution: the three-state
  mini-player model — `pipMinimized` store flag, `PipMiniBar` (64px bar,
  restore region + X), drag-below-peek now minimizes instead of closing, and
  the bar publishes `--pip-dock: 64px` on the document root so the app
  shells (and the dev playground) pad their content column above it.

## Validation gates (live browser, Chrome)

- **Gate 1 (vaul build): FAIL** — `aria-hidden="true"` on `#root` while sheet
  open; root cause vaul@1.1.2 never forwards `modal` to Radix Dialog Root
  (verified in dist); led to Amendment 1.
- **Gate 2 (motion sheet, 390×844): PASS** — open at peek 422/422 px; drag to
  expanded 793/793; same-snap spring-back verified post-fix (peek 422/422,
  expanded 793/793); resize re-anchor 658 = 0.94×700; slow-drag past
  threshold dismisses; background click swaps content + wheel-scroll +
  programmatic focus all work at peek; content-area drag does not move the
  sheet; X close plays slide-down exit; no aria-hidden outside the sheet.
- **Gate 3 (mini-bar): PASS** — bar exactly 64px, `--pip-dock` 64px set on
  documentElement and removed on close; drag-below-peek MINIMIZES with
  content retained; tap-restore lands at peek 422; X closes from both states;
  desktop-to-mobile crossing lands minimized; restore-after-crossing at peek.
- **Suite:** `pnpm test -- --run` 24/24 tasks; client 451 files / 5069 tests.
  Reviews: Rex APPROVE (c11344ac) + APPROVE (fe11fe676).

### Same-snap settle bug (found at gate, fixed)

A slow drag released onto the SAME snap left the sheet stuck mid-offset: a
drag mutates the y MotionValue without touching any animation target, so
re-rendering with an unchanged `animate` target is a no-op. Fixed by driving
every settle through `useAnimationControls` — an explicit `controls.start`
on drag release (including same-snap), with a settle effect covering entry,
snap changes, and resize. Verified live post-fix (Gate 2 numbers above).

## Deviations from the spec

- **`DesktopPip` stays mounted with `content: PipContent | null`:** the
  spec's suggested host shape (`if (pipContent === null) return null` at the
  top) would unmount the desktop `AnimatePresence` boundary and kill the
  panel's exit animation. The null-return applies only to the mobile branch;
  desktop keeps the conditional inside the always-mounted boundary.
- **`resetPreferences` clears `pipMinimized`:** it already clears
  `pipContent`/`pipGeometry`; leaving the new flag out would be an
  inconsistency. Not spec-mandated.
- **Minimized state unmounts the content renderer:** the bar shows only the
  pulse dot + title (per Amendment 2's structure); restore remounts content
  through the same path as a presenter swap — a `widget` replays its pinned
  stream gap-free via durable replay, an `mcp_app` refetches its frame.
- **Mobile sheet has a slide-down exit** (the spec accepted instant unmount
  for v1): wrapping the mobile branch in the same always-mounted
  `AnimatePresence` shape as desktop made it trivial, so the exit shipped.

## Known issues / follow-ups

- **Dev-route dock:** `DevPlayground.tsx` has its own `SidebarInset` layout
  that did not consume `--pip-dock`, so the mini-bar overlapped playground
  content by 64px on `/dev` routes — fixed in this commit (same
  `pb-[var(--pip-dock,0px)]` idiom as the shells).
- **Keyboard over bar (accepted v1 caveat):** with the on-screen keyboard
  open, mobile browsers are inconsistent about fixed-bottom elements riding
  the visual viewport; the bar may sit behind the keyboard while typing.
  Follow-up territory (visualViewport tracking).
- **vaul remains in the repo** for the seven modal Drawer consumers — only
  PIP dropped it. The `shared/ui/drawer.tsx` wrapper is byte-identical to
  its pre-feature state.
- **Exit animation + drag physics are browser-verified only:** the global
  jsdom test setup mocks `motion/react` (including the new `useDragControls`
  / `useAnimationControls` entries), so gesture mechanics live behind the
  validation gates above, not CI.
