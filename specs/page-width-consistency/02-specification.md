# Page width consistency — specification

**Work item:** DOR-1047 · **Spec id:** 260809-150251 · **Status:** frozen 2026-08-09

## 1. Tokens

In `apps/client/src/index.css`, alongside the existing `--msg-*` tokens (~line 209-218), add two page-width tokens:

```css
--page-width-wide: 80rem; /* dashboards, grids — Primer/Linear-class cap */
--page-width-reading: 56rem; /* forms, feeds, prose-leaning pages */
```

They live wherever the `--msg-*` family lives (same selector, same section comment style). These are the only two page-width knobs in the app. `--msg-content-max-width: 100ch` stays untouched as the chat-text knob.

Remove the `@utility container-default` block (`index.css:471-485`) in the same change — it is superseded, and the repo does not tolerate superseded patterns.

## 2. The `PageContainer` component

New file: `apps/client/src/layers/shared/ui/page-container.tsx`, exported from the `layers/shared/ui` barrel `index.ts` (FSD: shared layer, importable everywhere).

Contract (cva or tailwind-variants, matching whichever the neighboring shared/ui components use):

```tsx
interface PageContainerProps extends React.ComponentPropsWithoutRef<'div'> {
  /** Named width tier. No default — every page states its intent. */
  width: 'full' | 'wide' | 'reading';
  /**
   * true (default): PageContainer renders the page's scroll container
   * (h-full overflow-y-auto) around the centered content box.
   * false: no scroller; renders a full-height flex column for pages
   * that scroll an internal region (lists with pinned filter headers).
   */
  scroll?: boolean;
}
```

Rendered structure, `scroll: true` (the default):

```html
<div class="h-full overflow-y-auto">
  <div class="{inner}">{children}</div>
</div>
```

`scroll: false`:

```html
<div class="{inner} flex h-full min-h-0 flex-col">{children}</div>
```

Where `{inner}` is:

- base: `mx-auto w-full px-4 py-6 sm:px-6`
- `width: 'wide'` adds `max-w-[var(--page-width-wide)]`
- `width: 'reading'` adds `max-w-[var(--page-width-reading)]`
- `width: 'full'` adds nothing (gutters still apply)

Notes that are load-bearing:

- **`w-full` is baked into the base.** This is the fix for the shrink-wrap bug class; it can never be forgotten again.
- `className` merges onto the **inner** box via `cn()`; remaining div props spread onto the inner box too. (The outer scroller is an implementation detail pages don't style.)
- Native `overflow-y-auto`, not Radix `ScrollArea` — the app's global thin-scrollbar CSS (`index.css:571`) styles it; one scrollbar treatment everywhere.
- TSDoc on the export (Hard Rule 4).

Unit tests in `layers/shared/ui/__tests__/page-container.test.tsx`: each width renders its max-w class (and `full` renders none); `w-full` always present; `scroll: false` skips the scroller wrapper; className merge lands on the inner box.

Dev playground: add a PageContainer showcase per the `maintaining-dev-playground` conventions (three variants at a glance).

## 3. Route migration table

Every row below replaces a hand-rolled wrapper with `PageContainer`. File references are pre-verified (audit 2026-08-09); re-verify on contact — line numbers drift.

| #   | Surface             | File(s)                                                                                                                         | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Agent chat          | `layers/features/chat/ui/ChatPanel.tsx:333`                                                                                     | `mx-auto flex h-full w-full max-w-7xl flex-col` → `flex h-full w-full flex-col` (drop `mx-auto max-w-7xl`). Chat does **not** adopt PageContainer.                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2   | Agent chat scroller | `layers/features/chat/ui/MessageList.tsx:453`                                                                                   | drop `px-3` (rooms have none; rows carry `px-[var(--msg-padding-x)]`). Keep `pt-12`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 3   | Simulator           | `dev/simulator/SimulatorChatPanel.tsx:14`                                                                                       | mirror change #1 (it is a verbatim copy).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 4   | Marketplace page    | `layers/widgets/marketplace/ui/MarketplacePage.tsx:11` + `layers/features/marketplace/ui/Marketplace.tsx:31`                    | Page becomes `<PageContainer width="wide">`; delete the page's own `overflow-y-auto` wrapper and Marketplace's `mx-auto max-w-7xl space-y-8 px-4 py-8` (keep `space-y-8` on a plain div or pass via className). Fixes installed-view shrink-wrap.                                                                                                                                                                                                                                                                                                    |
| 5   | Marketplace sources | `layers/widgets/marketplace/ui/MarketplaceSourcesPage.tsx:11` + `layers/features/marketplace/ui/MarketplaceSourcesView.tsx:170` | `<PageContainer width="reading">`; delete `mx-auto max-w-2xl space-y-6 px-4 py-8` (keep `space-y-6`). Fixes shrink-wrap **and** adds the missing scroller.                                                                                                                                                                                                                                                                                                                                                                                           |
| 6   | Activity            | `layers/widgets/activity/ActivityPage.tsx:38-39`                                                                                | Replace `ScrollArea` + `mx-auto max-w-4xl space-y-4 py-6 sm:py-8` with `<PageContainer width="reading">` (+ `space-y-4`). Remove the child `mx-4` compensation at `:47`.                                                                                                                                                                                                                                                                                                                                                                             |
| 7   | Workspaces          | `layers/widgets/workspaces/ui/WorkspacesPage.tsx:109-110`                                                                       | Replace `ScrollArea` + `container-default mx-auto px-4 py-6` with `<PageContainer width="reading">`.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 8   | Connections         | `layers/widgets/connections/ui/ConnectionsPage.tsx:29`                                                                          | `container-default mx-auto px-4 py-6` → `<PageContainer width="reading">`. This **introduces** the page's scroll container; the existing `scrollIntoView` + `scroll-mt-6` then work.                                                                                                                                                                                                                                                                                                                                                                 |
| 9   | Feedback requests   | `layers/widgets/feedback-requests/ui/FeedbackRequestsPage.tsx:10`                                                               | `container-default mx-auto flex h-full flex-col px-4 py-6` → `<PageContainer width="reading" scroll={false}>` (panel scrolls internally).                                                                                                                                                                                                                                                                                                                                                                                                            |
| 10  | Team                | `layers/widgets/team/ui/TeamPage.tsx:121` (cards) + `layers/features/agents-list/ui/AgentsList.tsx` (table)                     | Cards: `flex h-full flex-col gap-4 overflow-y-auto p-4 md:p-6` → `<PageContainer width="full">` + `gap-4 flex flex-col` via className (PageContainer supplies scroll + gutters). Table path keeps its internal ScrollArea: wrap route content in `<PageContainer width="full" scroll={false}>` at the `TeamRoute` level **only if** it does not disturb the topology view — topology (`TeamRoute.tsx:140`) is a canvas surface and stays untouched. If wrapping at route level is risky, apply PageContainer to cards + table branches individually. |
| 11  | Tasks               | `layers/widgets/tasks/ui/TasksPage.tsx:122` + `layers/features/tasks/ui/TasksList.tsx`                                          | `<PageContainer width="full" scroll={false}>` around the page column; TasksList keeps its internal ScrollArea. Normalize its `p-4 pt-0` list padding to sit inside the container's gutters without double-padding (drop the horizontal padding from TasksList, keep vertical).                                                                                                                                                                                                                                                                       |
| 12  | Home chrome         | `layers/widgets/home/ui/PinnedTriageHeaderView.tsx:253,283`, `QuietStateLine.tsx:63`, `RoomStarterChips.tsx:52`                 | `mx-auto … max-w-4xl … px-4 sm:px-6` → `w-full px-[var(--msg-padding-x)]` (full-width banner, left edge aligned with message rows). No PageContainer — these live inside the chat pane.                                                                                                                                                                                                                                                                                                                                                              |

Empty/error/loading states inside each page keep their current centered styling; only the page-level wrapper changes.

## 4. What must NOT change

- `--msg-content-max-width`, `--msg-padding-x`, `--msg-gap`, `--msg-gutter-width` values and consumers (except the home-chrome alignment in row 12).
- Room surfaces (`RoomSurface`, `RoomTimeline`, `RoomHeader`, thread panel) — they are already the reference pattern.
- The AppShell / SidebarInset / Panel chain.
- Mobile behavior: below `sm` every migrated page renders edge-to-edge with 16px gutters, same as (or better than) today.

## 5. Acceptance criteria

1. At ≥1500px viewport: `/activity`, `/workspaces`, `/connections`, `/feedback-requests`, `/marketplace/sources` content boxes all measure exactly `min(pane, 896px)` wide with identical left offsets per pane; `/marketplace` (both views!) measures `min(pane, 1280px)`; `/team`, `/tasks` fill the pane with 24px gutters.
2. `/marketplace?view=installed` and `?view=browse` have **identical** wrapper geometry (the shrink-wrap bug is dead).
3. `/session` message rows and composer span the pane exactly like `/channels`; message text still caps at 100ch.
4. `/connections` and `/marketplace/sources` scroll when content exceeds the viewport.
5. Home pinned/triage chrome left edge aligns with message-row left edge.
6. `grep -r "container-default" apps/client/src` returns nothing (`apps/site` has its own independent utility of the same name — separate app, out of scope); `grep -rn "max-w-7xl\|max-w-4xl\|max-w-2xl" apps/client/src/layers --include=*.tsx` returns no page-level wrappers (component-internal uses like dialogs are exempt and must be individually justified).
7. `pnpm --filter @dorkos/client typecheck && pnpm --filter @dorkos/client lint` green; client test suite green; PageContainer unit tests pass.
8. Changing `--page-width-reading` to e.g. `64rem` in devtools visibly widens all five reading pages at once (the one-knob property, verified once in the browser).
