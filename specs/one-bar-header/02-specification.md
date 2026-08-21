---
id: 260821-202452
title: 'One Bar: header consistency across the cockpit'
status: specified
created: 2026-08-21
linear: DOR-1399
design-session: .dork/visual-companion/3968-1787342816
---

# Specification — One Bar

Every page in the cockpit gets exactly one 36px header row, owned by one declarative header system. Second and third header rows are eliminated. Decisions and their provenance: [design-decisions.md](design-decisions.md). Code references below were verified against `main` @ 496c3526c on 2026-08-21.

## 1. The bar grammar

One row, left to right:

```
[sidebar trigger + separator (desktop only)]
[identity zone: title | tab strip | avatar+name›session title | #name+topic]
[state chips: working · archived · bridge · origin …]
[flex space]
[page actions: New Agent / New Task / …]
[fixed cluster: search (CommandPaletteTrigger) · InboxBell · RightPanelToggle]
```

Invariants:

- **I1 — the fixed cluster.** Search, inbox bell, and right-panel toggle are always the last three items, in that order, on every route. Nothing ever renders between search and the right-panel toggle. The cluster has a fixed minimum width and is never crushed by identity content.
- **I2 — truncation priority.** When space runs out: the topic/description hides first; then chips compress to icon-only; then tab strips scroll (edge fades); identity never truncates below icon + name (min-width with ellipsis on the name itself as last resort).
- **I3 — no layout jump.** State controls that appear mid-stream (Stop/halt button, working chip) occupy reserved or animated space; their appearance must not shift the identity zone or the fixed cluster.
- **I4 — one tab language.** All in-bar tabs use one component (`BarTabStrip`, §3.3) with the HomeTabBar behavior: links styled as tabs, horizontal scroll with edge fades on overflow, active tab auto-scrolled into view. The pill tab row and the mobile `<Select>` collapse are removed from the codebase.
- **I5 — drag region (desktop shell).** Window dragging binds to empty bar space only; tabs, chips, and buttons are `app-region: no-drag`. Verified in the desktop app, where `AppTabBar` sits above this bar.

## 2. Current state being replaced

From the architecture trace (2026-08-21):

- `AppShell.tsx:608-648` renders the single `<header>`; `useHeaderSlot()` (AppShell.tsx:190-258) maps `pathname → header component` via a hardcoded switch.
- `layers/features/top-nav/ui/PageHeader.tsx` is the shared primitive; 10 thin per-route wrappers use it; `SessionHeader.tsx` bypasses it and hand-rolls the same layout.
- `layers/widgets/room-view/ui/RoomHeader.tsx` is the stacked second row on channels and Home (rendered by `RoomSurface.tsx:298`).
- `layers/widgets/home/ui/HomeTabBar.tsx` is the surface tab strip under a pathless `_home` layout route (`HomeSurfaceLayout.tsx`); tab definitions in `home/lib/home-tabs.ts`.
- `layers/features/top-nav/ui/TeamHeader.tsx` owns the pill tabs (desktop) and `<Select>` collapse (mobile).
- `layers/features/activity-feed-page/ui/ActivityFilterBar.tsx` renders filter chips inside the bar via `ActivityHeader`.
- Room management is the modal `RoomDetailsDialog` (`layers/features/room-management/`), opened from three entry points (RoomHeader avatars, RoomFlow empty state, sidebar RoomRow menu).
- The right panel is contribution-based: `RightPanelContribution` slot (`extension-registry.ts:146`), built-ins registered in `app/init-extensions.ts:142-274` (`registerRightPanelTabs`), tab strip in `RightPanelHeader.tsx`. On `/channels` only the global Pulse tab is visible today.

## 3. Architecture

### 3.1 `OneBar` primitive (evolves `PageHeader`)

`layers/features/top-nav/ui/OneBar.tsx` (rename/evolve `PageHeader.tsx` — keep the file history via git rename). Props (shape, not final names):

```ts
{
  identity: ReactNode;      // title text, BarTabStrip, RoomIdentity, SessionIdentity
  chips?: ReactNode;        // state chips after identity
  actions?: ReactNode;      // page actions before the fixed cluster
}
```

The fixed cluster is rendered by `OneBar` itself (search always included, as `PageHeader` does today with `CommandPaletteTrigger`), so I1 cannot be violated by a consumer. `InboxBell` and `RightPanelToggle` move from `AppShell` into `OneBar`'s cluster so all three live together (AppShell keeps mounting the bar itself).

### 3.2 Declarative route headers

Kill the `useHeaderSlot` switch. Each TanStack route declares its header in `router.tsx` via route `staticData` (or `context`) — e.g. `staticData: { header: ChannelsBar }`. `AppShell` resolves the matched route's header component and renders it inside the existing `AnimatePresence` cross-fade. One file owns route + header together; adding a route without a header is a type error (staticData typed, header required — pages with no special content use a `TitleBar` helper with a string).

The six one-line title-only wrappers (`WorkspacesHeader`, `ConnectionsHeader`, top-nav `MarketplaceHeader`, `MarketplaceSourcesHeader`, `FeedbackRequestsHeader`, and similar) collapse into inline `TitleBar` declarations; their files are deleted.

### 3.3 `BarTabStrip`

Extract HomeTabBar's mechanics (links-as-tabs rationale in its doc comment, `useScrollOverflow` fades, active-tab reveal) into a reusable `BarTabStrip` sized for in-bar use. Consumers:

- **Home surfaces**: Home · Activity · Scheduled · Workspaces (same routes as today; `_home` layout route stops rendering a tab row — the bar shows it instead).
- **Team views**: Cards · Table · Topology · │ · Denied · Access (divider between primary and management groups). Writes `?view=` exactly as `TeamHeader` does today. The mobile `<Select>` and `mobileTabs()` filter are deleted; all five views reachable by scroll on mobile.

`HomeTabBar.tsx` is deleted after extraction; `home-tabs.ts` definitions are reused as the strip's input.

### 3.4 Per-route bars

| Route                                                                                  | Identity zone                                                                                 | Chips                                                                                                                          | Actions                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                                                                                    | `BarTabStrip` (home surfaces), Home active                                                    | system-health dot (kept, moves next to the strip's Home tab or into chips zone); `#team` members chip (opens room right panel) | —                                                                                                                                                                                               |
| `/activity`                                                                            | same strip, Activity active                                                                   | —                                                                                                                              | — (filter chips move into `ActivityPage` content, first row — same pattern `/tasks` already uses; `ActivityHeader` + in-bar `ActivityFilterBar` placement deleted, component reused in content) |
| `/tasks`                                                                               | same strip, Scheduled active                                                                  | —                                                                                                                              | New Task                                                                                                                                                                                        |
| `/workspaces`                                                                          | same strip, Workspaces active                                                                 | —                                                                                                                              | —                                                                                                                                                                                               |
| `/channels`                                                                            | `RoomIdentity`: `#` icon · room name · topic (dimmed, hides first)                            | Archived badge · bridge-visibility badge · "N working" chip · Stop/halt · members chip (`👥 N`, opens room right panel)        | —                                                                                                                                                                                               |
| `/session`                                                                             | `SessionIdentity`: agent avatar (via `resolveAgentVisual`) · agent name · `›` · session title | origin chip (`SessionOriginMark`, kept)                                                                                        | —                                                                                                                                                                                               |
| `/team`                                                                                | "Team" title + `BarTabStrip` (team views)                                                     | —                                                                                                                              | New Agent (icon-only `+` on mobile)                                                                                                                                                             |
| `/marketplace`, `/marketplace/sources`, `/connections`, `/feedback-requests`, `/dev/*` | `TitleBar` string                                                                             | —                                                                                                                              | route-specific                                                                                                                                                                                  |

`RoomHeader.tsx` is deleted; `RoomSurface` stops rendering a header row (the `aboveTimeline` slot and everything else stays). The room data the bar needs is already client-cached (the same query `useRoomDocumentTitle` uses today resolves the title in AppShell; extend to the full room object + members).

**Session title source**: the same per-session title the sidebar list renders (runtime-owned session metadata). Falls back to "New session" before a title exists; updates live via the existing session queries. No new server API.

### 3.5 One door to #team (B1)

`/channels` route gains a guard: if `id` resolves to the team room, redirect to `/`, carrying `?thread=` through (Home's `RoomSurface` already supports `threadRoute="/"`). The sidebar #team entry links to `/`. The team-room id is already resolved client-side by `HomeRoomPage`; reuse that resolution (no flash: redirect in route `beforeLoad`/loader once the team-room query resolves, falling back to rendering nothing rather than the channel view).

### 3.6 Room right panel (C2 expanded)

Register a **Room** `RightPanelContribution` in `registerRightPanelTabs` (`init-extensions.ts`), `visibleWhen: pathname === '/channels' || pathname === '/'` (any route rendering a room). Contribution priority places it before Pulse's fallback ordering so it auto-selects on room routes (the existing "contextual wins over global" auto-select handles this).

Content: a new `RoomPanel` in `layers/features/room-management/` re-hosting the dialog's composition — `RoomDetailsHeader` (name/topic editing), `RoomLoudnessLine`, `RoomMemberList`/`RoomMemberRow` (profile link, presence, loudness rung editor, remove-with-confirm), `AddMembersRow`, `RoomDetailsFooter` (archive/lifecycle) — backed by the existing `useRoomDetailsView` / `useRoomDetailsWrites` hooks. Panel layout instead of modal layout; scrollable; works in both `resizable` (desktop) and `overlay` (mobile/Obsidian) panel modes, which the container already provides.

Focus routing: the `RoomDetailsFocus` union (`'members' | 'add' | 'topic'`) survives as the panel's imperative focus API — opening the panel with a focus scrolls to/expands the right section. Entry points re-pointed:

1. Bar members chip → open right panel, Room tab, focus `members`.
2. RoomFlow empty-state "add agents" → open panel, focus `add`.
3. Sidebar RoomRow menu (Add agents / Members / Edit topic…) → open panel with matching focus. (Rename/Archive stay in the row menu, unchanged — DOR-1233 division holds. "Leave" unchanged.)

`RoomDetailsDialog.tsx` is deleted once all three doors re-point. The mobile rationale that made it a modal (sidebar-drawer anchoring, spec §14.5 of the rooms spec) is satisfied by the panel's existing `overlay` mode.

Which room does the panel show? The room the current route displays (`/channels?id=…` or Home's #team). The contribution's component reads the same route/room resolution the bar uses; no global "selected room" state is added.

### 3.7 Deletions & renames (leave-it-cleaner riders)

- Delete: `RoomHeader.tsx`, `HomeTabBar.tsx` (post-extraction), `TeamHeader` pills + `<Select>`, `SessionHeader` breadcrumb, `RoomDetailsDialog.tsx`, six title-only header wrapper files, `useHeaderSlot` switch.
- Drop in-page H1s (E1): `Marketplace` (widget page), `Workspaces`, `Connections` — pages open with their one-line description. Audit other routes for the same pattern while there.
- Rename `layers/features/marketplace/ui/MarketplaceHeader.tsx` → `MarketplaceToolbar.tsx` (resolves the name collision).
- `PageHeader`'s consumer-specific TSDoc moves to the truncation policy doc on `OneBar`.

## 4. Mobile (390px) & desktop shell

- Phone keeps the bar (no sidebar trigger, as today). Home surface tabs render in the bar; the **bottom tab bar coexists** — before building past P1, a quick playground/browser prototype of the phone Home bar decides whether the surface tabs stay in the bar on phones or the phone keeps a reduced identity ("Home" + chips) with surface switching left to the bottom nav. This is an explicit checkpoint (flagged to Dorian with screenshots), not an assumption.
- Channel bar on phone: topic hidden (I2), working state becomes a dot on the members chip, halt stays reachable.
- Team on phone: strip scrolls; New Agent is a `+` icon button.
- Desktop shell: I5 drag rules; verify with the built Electron app, not just the web build.
- Embedded Obsidian mode: bypasses the router; bar must degrade to the embedded chrome (no router-derived tabs). Conformance-check in the plugin build, not assumed.

## 5. Edge cases (behavioral contract)

1. Long room names / topics (user-controlled): I2 order; name ellipsis only as last resort; tooltip shows full text.
2. Stop button appears/disappears mid-run: I3 (reserved/animated space).
3. Session with no agent (bare directory): directory-name fallback + generic mark, never an empty avatar. Agent renamed/deleted mid-session: last-known name.
4. Session title streams in after first turn; room rename: bar updates in place (existing AnimatePresence crossfade; no flicker/remount).
5. Right panel open/close changes bar width: overflow recalculates via ResizeObserver (not window resize).
6. `/channels` with unknown/archived id: "That conversation isn't here" page keeps a plain `TitleBar("Channels")` bar.
7. Redirect preserves `?thread=`; non-team channel links unaffected; `/agents → /team` untouched.
8. #team members chip shows 46+: chip renders count; panel list scrolls (virtualize only if it measurably janks).
9. Home Pulse tab remains reachable when the Room tab auto-selects (both visible in the strip).
10. Room tab + a `/session`-gated tab set never coexist (route-gated), but Profile can appear on `/channels`? Today Profile requires `explicitAgentPath` — unchanged.
11. Keyboard: ⌘K search unchanged; bar is a `nav` landmark; tabs are links with `aria-current`; members chip is a labeled button ("N members"); right-panel tab semantics already handled by `RightPanelHeader`.
12. Document titles: unchanged (they already derive from route/room, not from header components).

## 6. Verification

- **Unit**: OneBar cluster ordering (I1) — a test that renders each route bar and asserts the last three controls; BarTabStrip overflow + active reveal (jsdom-safe parts); redirect guard (team id → `/`, thread preserved); room panel focus routing; entry-point re-pointing (RoomRow menu opens panel, not dialog).
- **Playground** (reconciled per `maintaining-dev-playground`): showcases for `OneBar` variants (title, tabs, room, session incl. long-name/archived/working states), `BarTabStrip` (overflow, divider, mobile width), members chip, `RoomPanel` (populated/empty/DM/archived — reuse the existing `RoomsShowcases` fixtures), at desktop and 390px widths. The existing Room Sheet showcase section is replaced by the RoomPanel one.
- **Browser (real)**: every route at 1440 and 390; channel double-header gone; home is one bar + content; Electron drag check; Obsidian embed smoke check. Screenshots attached to DOR-1399.
- **e2e**: update selectors that reference removed headers; add a channels smoke assertion (single header, members chip opens panel).
- Adversarial review per REVIEW.md before each PR opens (repo standard).

## 7. Out of scope

- New server APIs (everything reads existing queries).
- Right-panel tabs for rooms beyond the one Room tab (Canvas/Files for rooms etc. — future).
- Sidebar changes beyond re-pointing the #team link and the RoomRow menu actions.
- Mobile bottom-nav redesign.

## 8. Suggested phasing (input to DECOMPOSE)

1. **Foundation**: OneBar primitive + declarative route headers + BarTabStrip extraction + fixed cluster (I1) — visual parity release, no page redesigns yet. Includes playground scaffolding.
2. **Home surfaces**: tabs into bar on `/`, `/activity`, `/tasks`, `/workspaces`; activity filters into content; health dot placement; phone-Home checkpoint with Dorian.
3. **Channels**: RoomIdentity bar, RoomHeader deletion, members chip, B1 redirect.
4. **Room right panel**: Room contribution, RoomPanel, dialog elimination, entry-point re-pointing.
5. **Session**: SessionIdentity bar.
6. **Team**: BarTabStrip views, select-box removal, mobile `+`.
7. **Sweep**: E1 H1 drops, MarketplaceToolbar rename, dead-code/knip pass, docs/changelog fragments.

Phases 3+4 may merge if the PR stays reviewable; each phase is its own worktree + PR + adversarial review.
