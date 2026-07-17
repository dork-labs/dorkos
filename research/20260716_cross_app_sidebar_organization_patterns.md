---
title: 'Sidebar Organization Patterns in World-Class Apps — Comparative Study'
date: 2026-07-16
type: external-best-practices
status: active
tags:
  [
    sidebar,
    organization,
    groups,
    favorites,
    pinning,
    recents,
    drag-and-drop,
    multi-presence,
    discord,
    notion,
    linear,
    telegram,
    arc,
    spotify,
    dnd-kit,
    wcag,
  ]
sources_count: 30
related_spec: agent-sidebar-organization
---

# Sidebar Organization Patterns in World-Class Apps: A Comparative Study

**Date**: 2026-07-16
**Objective**: How world-class apps let users organize items in sidebars/lists — groups/folders, favorites/pinning, recents, drag-and-drop, multi-presence, rule-based membership, and progressive disclosure — to inform DorkOS agent sidebar organization (spec `agent-sidebar-organization`, DOR-329). Companion report: `20260716_slack_sidebar_organization_ux.md`.

## 1. Discord — Server Folders + Favorites

**Groups (server folders):** Created by drag-and-drop only — no "New Folder" menu item. Drag one server icon onto another; they combine into an unnamed, uncolored folder. Mobile: long-press, drag, drop when the target highlights. A folder holds up to 100 servers. ([Server Folders 101](https://support.discord.com/hc/en-us/articles/360030853132-Server-Folders-101))

**Naming/coloring:** Right-click a folder → Folder Settings for name and color. Hovering an unnamed folder previews the servers inside.

**Removal/deletion:** Drag a server out to remove it. A folder with zero servers **auto-deletes** — emptying it is the delete gesture. Creation and destruction use the _same_ gesture vocabulary (drag in / drag out); no menu needed for folder lifecycle.

**Unread badges:** On a _collapsed_ folder, unread state from any server inside rolls up to the folder icon (dot or number). Right-click a folder → "Mark as Read" clears everything inside in one action.

**Favorites (separate, newer feature, Nitro experiment as of 2026):** item-level, cross-server favorites for channels/DMs surfacing in a dedicated top section, with sub-categories. Evidence that one grouping mechanism doesn't satisfy all organizational needs at scale. ([Favorites FAQ](https://support.discord.com/hc/en-us/articles/38810584460439-Favorites-FAQ))

**Embedded lesson:** no explicit "create folder" button — the feature is discovered through the drag gesture itself (progressive disclosure via affordance overloading rather than UI chrome).

## 2. Notion — Sidebar Sections + True Multi-Presence Favorites

**Sidebar sections (Home tab):** Upcoming events, Recents, Favorites, Teamspaces, Shared, Private — the taxonomy only fully materializes once a workspace has enough content to need it. ([Navigate with the sidebar](https://www.notion.com/help/navigate-with-the-sidebar))

**Favorites is genuinely multi-presence — the key finding.** Clicking ⭐ on any page adds a _reference_ to the Favorites section; the page's canonical location is unaffected — the same page renders in two places in the tree simultaneously. Un-favoriting removes only the shortcut, never the page. Notion recommends restraint: "add just a handful of pages to your favorites" — multi-presence degrades if overused. ([Structure your sidebar](https://www.notion.com/help/guides/structure-sidebar-focused-work-teamspaces))

**Hover-reveal affordances:** hovering a row surfaces **+** (add child) and **•••** (menu). Nothing visible at rest — the sidebar stays visually quiet and "wakes up" on intent.

**Collapse/reorder:** section headers collapse whole sections; Notion's own guidance for organizing is _manual and persistent_ — keep frequent teamspaces at top with toggles open, collapse and demote rare ones. Users hand-curate a stable spatial layout rather than rely on auto-sort.

**Progressive disclosure:** sections with no content don't render (no Shared section until something is shared). Conditional rendering triggered by data existing, not a settings flag.

## 3. Linear — Favorites Across Many Object Types + Explicit Sidebar Customization

**What can be favorited:** issues, projects, views, documents, initiatives, cycles, labels, teams, customers, dashboards, PRs, releases. ([Favorites – Linear Docs](https://linear.app/docs/favorites))

**Multi-presence:** favorites are "personal shortcuts which appear in your sidebar" — the item stays in its team/project location; the favorite is an additional pointer.

**Favorites folders:** a folder _within_ Favorites (one nesting level), drag in/out — a second opt-in tier of grouping only relevant once someone has enough favorites.

**Keyboard-first:** `O` then `F` opens a favorites picker anywhere; `Alt+F` toggles favorite on the focused item.

**Sidebar customization (Dec 2024 redesign):** "Customize sidebar" mode — reorder via drag-and-drop, hide unused items, choose unread rendering (count vs dot). Framed as control over information density. ([Changelog](https://linear.app/changelog/2024-12-18-personalized-sidebar))

**Design philosophy:** the sidebar stays fixed while only the content area transforms, so "your brain maintains spatial context because the frame never breaks." ([How we redesigned the Linear UI](https://linear.app/now/how-we-redesigned-the-linear-ui))

## 4. Telegram — Rule-Based Folder Membership (the odd one out)

Telegram's folder membership is **rule-based rather than purely manual** — the standout mechanic worth borrowing selectively.

**Creation flow:** Settings → Chat Folders → Create New Folder. Two rule sets: **Included Chats** (individually, or by _type_ — Channels, Groups, Contacts, Bots, Unread) and **Excluded Chats** (by chat or by state — Muted, Read, Archived). Live membership = `include minus exclude`, re-evaluated continuously (a chat drops out of an "Unread" folder the moment it's read). ([Telegram blog: Chat Folders](https://telegram.org/blog/folders))

**Folders as tabs, not a tree:** folders render as a horizontal tab strip — parallel _views_ of the same chat list, not containers that own their contents.

**A chat can belong to multiple folders simultaneously** — membership is rule-derived, so multi-presence is structural (via query) rather than editorial.

**Pinning within folders:** each folder has its own independent pinned set — pin state is folder-scoped.

**Badges:** each folder tab shows its own unread count.

**Progressive disclosure:** folders "become available in the interface when your chat list is long enough to start getting cluttered" — auto-surfaced by a data threshold, with manual early opt-in.

## 5. Arc Browser — Three Persistence Tiers, and a Real Post-Mortem on Confusion

**Three tiers:** **Favorites** (icon-only, global across Spaces) · **Pinned Tabs** (per-Space, never auto-archive) · **Today tabs** (per-Space, auto-archived after ~12h idle). **Spaces** are named, color-coded containers bundling a pinned set + a Today bucket. ([Arc resources](https://resources.arc.net/hc/en-us/articles/19230755904151-Favorites-Top-Tabs-Across-Every-Space))

**Documented failure mode:** The Browser Company's candid postmortem: cross-window tab sync caused accidental closes/data loss → removed sync (June 2023) → unsynced model broke Spaces ("members struggled finding tabs across multiple windows") → reverted (August 2023), accepting "some members take over a year to finally come around." ([There and back again](https://browsercompany.substack.com/p/there-and-back-again-the-product))

Reviews describe persistent ambiguity: **"Should I make a Space, or a new window?"** — multiple organizational primitives (Spaces, Pinned, Favorites, Today, Profiles) compounded the mental model for new users, even though power users eventually loved it.

**Takeaway:** the cautionary tale — stacking multiple semantically-similar "keep this around" primitives without a crisp mental model creates real, admitted, expensive-to-fix confusion.

## 6. VS Code / JetBrains — Pinned Tabs + Recency-Ranked Quick Open

**VS Code pinned tabs:** pin shifts the tab left with a pin glyph; stays put regardless of what opens/closes — a lightweight "keep this visible" mechanic distinct from grouping.

**Quick Open (Cmd+P) recency ranking:** results seeded with recently opened files before typing — `Cmd+P` `Enter` reopens the most recent file (one-keystroke "go back"). Typing switches ranking from recency to fuzzy relevance. Persists 100 recent files across restarts; specific files can be pinned to the top of the recency list.

**JetBrains Recent Files (Cmd+E):** popup of recent files; second `Cmd+E` narrows to "edited only" (stricter recency signal). Recent Locations (Cmd+Shift+E) shows code snippets around last-viewed positions — recency of _attention_, not just of open.

**Pattern worth naming:** two parallel systems — a soft auto-computed recency list (bounded, decaying) and a hard manual pinned layer that overrides recency. This pinned-overrides-recency hybrid recurs across Spotify, Arc, Telegram, Slack, Teams.

## 7. Spotify — Pin, Folders, Filter Chips, and an Explicit "Custom Order" Sort Mode

**Pinning in Your Library:** pin jumps an item to the top; cap raised **4 → 20** in a 2026 update after power users hit the ceiling.

**Playlist Folders:** nestable; a folder itself can be pinned like a playlist.

**Filter chips:** horizontal type filters (Playlists / Artists / Albums / Podcasts), combinable.

**Sort includes an explicit "Custom order" mode** alongside Recently Added / Alphabetical / Recently Played / By Creator — the clearest production illustration of manual-vs-auto sort conflict resolution: drag-reordering is only active under "Custom order"; switching to an auto-sort **doesn't discard** the custom order, it just stops displaying it until the user switches back. The orderings coexist as separate, non-destructive states. Spotify's community has repeatedly demanded "Bring Back Custom Sorting" whenever redesigns threatened it — users treat manually-curated order as a durable investment. ([Spotify Community](https://community.spotify.com/t5/Your-Library/Bring-Back-Custom-Sorting/td-p/5570520))

**Grid/list toggle:** display density orthogonal to sort/filter/group, persisted per view.

## 8. macOS Finder Sidebar Favorites — the Cleanest Multi-Presence Mental Model

- **Add:** drag a folder onto Favorites (⌘-drag for files/apps to signal "reference, don't relocate").
- **Remove:** drag the entry out until a removal cue appears, or right-click → Remove. Apple's docs are explicit: _"the folder, disk, or file remains in its original location"_ — removal is never destructive.
- **Reorder:** plain drag. **Collapse:** per-section Show/Hide on header hover, persisted.

One gesture family (drag) does add, remove, and reorder, with one modifier disambiguating reference vs move. ([Apple Support](https://support.apple.com/guide/mac-help/customize-the-finder-sidebar-on-mac-mchl83c9e8b8/mac))

## 9. Established UX Research

**Spatial memory backs "manual over auto-sort."** NN/g: spatial memory develops only in "stable UIs where things don't move around (much)"; adaptive/auto-rearranging interfaces "have not worked well because they break users' ability to build spatial memory." Where frequency-based shortcuts are wanted, NN/g recommends **duplicating** the item (normal place + "Frequently Used" area) rather than moving it — direct research backing for the multi-presence pattern Notion/Linear/Finder converged on. Spatial memory is "neighborhood-level," built on boundaries/landmarks (section dividers, headers), not tree depth. ([NN/g: Spatial Memory](https://www.nngroup.com/articles/spatial-memory/))

**Hover-only affordances trade discoverability for quietness.** Keep dense lists calm at rest, but pair with a persistent keyboard-reachable equivalent (overflow menu, context menu) — hover-only excludes touch and keyboard users.

**Drag-and-drop accessibility is a formal standard.** WCAG 2.2 **2.5.7 Dragging Movements** (AA, 2023): any drag-based reordering needs a single-pointer alternative. Recommended: up/down buttons, "move to position" picker, or a keyboard drag protocol (Space to pick up, arrows to move, Space to drop, Escape to cancel) — exactly what `@dnd-kit`'s `KeyboardSensor` implements. ([Sparkbox on WCAG 2.5.7](https://sparkbox.com/foundry/understanding_implementing_wcag_dragging_movements_accessibility))

**Pinned+recents hybrids are the dominant real-world pattern.** Slack (starred + custom sections + per-section sort), Teams (pinned chats capped at 15 above a Recent section), VS Code/JetBrains, Spotify, Arc — all layer a manual pin tier over an automatic recency tier.

**Empty-state / progressive-disclosure convention:** conditional rendering triggered by data existing, not a settings toggle — Notion's sections, Telegram's threshold-triggered folders, Discord's chrome-free gesture discovery. ([NN/g: Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/))

## 10. React DnD Libraries — Current Consensus (2026)

**`@dnd-kit`** is the pragmatic default for accessible list drag-and-drop in React 19: ~6KB core, actively maintained, accessibility built in — `KeyboardSensor` implements the WCAG keyboard drag protocol out of the box, plus automatic ARIA live-region announcements. Reportedly used by Linear for issue reordering. Alternative: Atlassian's **`pragmatic-drag-and-drop`** (<4KB, fully headless, zero imposed UI) for teams wanting total control at very large scale. Guidance: default to `@dnd-kit`. ([dndkit.com](https://dndkit.com/), [comparison](https://www.pkgpulse.com/guides/dnd-kit-vs-react-beautiful-dnd-vs-pragmatic-drag-drop-2026))

## Comparison Table

| App                     | Groups/Folders                                        | Favorites/Pinning                                              | Multi-Presence                       | Recents/Smart Sections                    | Drag-and-Drop                     | Rule-Based Membership   | FTUX / Progressive Disclosure             |
| ----------------------- | ----------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------ | ----------------------------------------- | --------------------------------- | ----------------------- | ----------------------------------------- |
| **Discord**             | Server folders (drag-onto), auto-delete when empty    | Separate Favorites (Nitro-gated) with sub-categories           | No — folder membership exclusive     | Badges roll up unread, not recency        | Core creation mechanic itself     | No                      | Zero chrome — discovered via drag gesture |
| **Notion**              | Teamspaces, collapsible                               | Favorites (⭐), vendor guidance to keep small                  | **Yes — canonical example**          | Recents on Home tab                       | Drag to reorder                   | No                      | Sections render conditionally on data     |
| **Linear**              | Favorites folders (one level); team/project hierarchy | Favorites across 12+ object types; `Alt+F`                     | Yes — shortcut, item stays put       | Sidebar customization instead             | Full sidebar drag reorder         | No                      | Favorites appears after first favorite    |
| **Telegram**            | Folders as horizontal tabs                            | Per-folder pinned chats                                        | **Yes, structurally** (rule-derived) | "Unread" as a rule-type                   | Not core (declarative)            | **Yes — standout case** | Auto-surfaces once chat list is long      |
| **Arc**                 | Spaces                                                | Favorites (global) / Pinned (per-Space) / Today (auto-archive) | Favorites cross-Space                | Auto-archive idle tabs (12h)              | Drag to pin/reorder               | No                      | Documented confusion — cautionary case    |
| **VS Code / JetBrains** | N/A                                                   | Pin tabs; pin files in recency list                            | Soft (pinned also in recents)        | Cmd+P / Cmd+E recency lists, 100-file cap | N/A                               | No                      | Always-on recency, no gate                |
| **Spotify**             | Playlist folders (nestable)                           | Pin (4→20 cap); folders pinnable                               | Pin promotes a reference to top      | Recently Played/Added sort modes          | Only under "Custom order" sort    | No                      | Filter chips; folders opt-in              |
| **Finder**              | N/A (flat Favorites; Tags as soft alternative)        | Favorites section                                              | **Yes, cleanest case**               | N/A                                       | One gesture family for everything | No                      | Per-section show/hide                     |

## Design Lessons for DorkOS

1. **Default to a flat list; introduce grouping chrome only once data volume demands it.** A cockpit with 3 agents should look nothing like one with 30. (Telegram ties folder visibility to list length.)
2. **Make favorites/pinning multi-presence, not exclusive membership.** A pinned agent still appears in its group. (NN/g duplication recommendation; Notion/Linear/Finder convergence.)
3. **Manual order is a durable, non-destructive user investment — never silently discarded by auto-sort.** Store custom order even while an auto-sort mode is active. (Spotify's coexisting sort modes.)
4. **One gesture family for add/remove/reorder.** (Finder, Discord.)
5. **Never make drag-and-drop the only way to reorder.** WCAG 2.2 §2.5.7; adopt `@dnd-kit`'s KeyboardSensor protocol.
6. **Cap pins/favorites modestly, revisit empirically.** (Spotify 4→20; Teams 15.)
7. **Roll unread/activity state up to collapsed groups; support group-level "mark read."** (Discord folder badges.)
8. **Persist collapse/expand per section; never reset layout.** (NN/g stability; Finder/Notion persistence.)
9. **Consider rule-based ("smart") membership alongside manual grouping** — agents have rich metadata (runtime, project, status, last-active); rule-based groups need zero maintenance as state shifts. (Telegram.)
10. **Hover affordances need a persistent keyboard-reachable pair.** (Notion's ••• pattern.)
11. **Don't stack semantically-overlapping "keep this around" primitives without a one-sentence distinction each.** (Arc's postmortem.)
12. **Broad and shallow beats deep nesting; boundaries/landmarks convey structure, not indentation depth.** Every app studied caps grouping at one or two levels. (NN/g.)
