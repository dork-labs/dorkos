# Design Decisions — One Bar

Visual companion session: `.dork/visual-companion/3968-1787342816/`
Work item: DOR-1399. Decided with Dorian, 2026-08-21.

## 1. Structural direction

**Screen:** `header-direction.html`
**Options:** A) One Bar — everything in a single header row (pure Slack). B) Bar + Rail — identity row + shared underline tab rail. C) Targeted fixes only.
**Chosen:** **A — One Bar.** Every page gets exactly one header row; second and third header rows are eliminated. Filters and toolbars move into content.

## 2. Mobile overflow

**Screen:** `one-bar-details-v2.html` (Q1)
**Chosen:** **A1 — scrollable bar with edge fade.** Reuse the shipped HomeTabBar overflow behavior (scroll, edge fades, active tab auto-scrolled into view). The action cluster (search · inbox bell · right-panel toggle) is fixed outside the scroll area. Search sits always immediately left of that cluster — nothing may ever render between search and the right-panel toggle.

## 3. Two doors to #team

**Screen:** `one-bar-details-v2.html` (Q2)
**Chosen:** **B1 — one door.** `/channels?id=<team-room-id>` redirects to `/`, preserving `?thread=`. The sidebar #team entry links to `/`.

## 4. Members control → room right panel

**Screen:** `one-bar-details-v2.html` (Q3)
**Chosen:** **C2, expanded by Dorian:** the bar's members chip opens the **right panel**, not a popover. Further: the existing `RoomDetailsDialog` (room management modal — members, add agents, loudness rungs, topic, archive) is **eliminated**; its content moves into a new tabbed **room right panel**, following the session right-panel model (`RightPanelContribution` registrations, shared `RightPanelHeader` tab strip) and reusing its components wherever possible. This is the start of rooms having right-panel tabs like sessions do.

## 5. Session bar identity

**Screen:** `one-bar-details-v2.html` (Q4)
**Chosen:** **D1 — avatar + agent name › session title.** Replaces the "Team › DorkBot › Session" breadcrumb. Title comes from the same source the sidebar uses for session names and updates live; fallback "New session". Origin chip (scheduled/relay/…) stays when present.

## 6. In-page duplicate H1s

**Screen:** `one-bar-details-v2.html` (Q5)
**Chosen:** **E1 — drop the visual in-page H1** on Marketplace, Workspaces, Connections (and any other page that repeats the bar title). The bar owns the visible name; pages keep their one-line description. Shipped form (program-wide, started in H1): an `sr-only` h1 stays in the DOM so the page keeps a named heading outline for screen readers.

## Final design summary

One 36px header bar per page, owned by a single declarative header system. The bar's grammar, left to right: sidebar trigger (desktop) · page identity (title, tabs, or avatar+name) · contextual state chips · flexible space · page actions · **search · inbox bell · right-panel toggle** (fixed cluster, never crushed, never reordered). Channels show `# name · topic · state chips · members chip` in the bar and lose the stacked RoomHeader. Home shows its four surface tabs directly in the bar and loses both the "Home" title row and the #team identity row. Team's five views become bar tabs in the same scrollable style (mobile select box removed; New Agent collapses to a `+` icon on mobile). Activity's filter chips move into the content area. Sessions show agent avatar + name › session title. Room management lives in a tabbed room right panel. Truncation priority when space runs out: topic hides first, then chips compress to icons, then tabs scroll; identity never truncates below icon + name.
