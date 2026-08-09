---
title: 'Design Meta 2026 — Codified Learnings for the Component Overhaul'
date: 2026-08-09
type: external-best-practices
status: active
tags:
  [
    design-system,
    sidebar,
    density,
    hover-reveal,
    separators,
    calm-tech,
    navigation,
    mobile,
    agent-status,
  ]
---

# Design Meta 2026 — Codified Learnings

Distilled from the 2026-08-09 sidebar redesign session (visual companion session
`.dork/visual-companion/19627-1786276365/`), a code-level audit of the current
sidebar, and fresh research into Slack, Linear, Discord, Notion, Arc, Superhuman,
Raycast, and Buzz. Written to outlive the sidebar work: these are the standing
rules for modernizing **every** DorkOS component.

Companion reports (already in `research/`):

- `20260716_slack_sidebar_organization_ux.md` — Slack mechanics in depth
- `20260716_cross_app_sidebar_organization_patterns.md` — grouping patterns + NN/g spatial-memory evidence

## The ten rules

### 1. Two spatial modes: content surfaces vs control surfaces

"Generous space" (Calm Tech) applies to **content** — pages, cards, empty
states, reading surfaces. **Control surfaces** (sidebars, toolbars, list panes,
menus, table rows) follow the density meta instead:

- Text 13px, metadata 11px
- Row height 28–32px (4px-grid multiples)
- **16px total left inset** from panel edge to first glyph — never stack
  container + section + row padding (the old sidebar stacked 12 + 8 + 10 = 30px)
- Panel width for nav sidebars: 240–280px
- Linear's stated compact baseline: 14px/20px line-height fits ~1.5× more nav
  items in the same space, with _less_ perceived noise, not more

The test: does the user **operate** this surface many times an hour (dense) or
**read** it (generous)?

### 2. Tint, not lines

Hairline borders between regions are the dated signal. Separate with, in order
of preference:

1. **Whitespace** (a gap is the cheapest separator)
2. **Background tint shift** of 5–10% (e.g. a zone rendered on `muted/40`)
3. **Elevation** — reserved, scarce, only for things that genuinely float
   (popovers, drag previews, the active item at most)

Scroll-edge shadows (a soft shadow that appears only once content scrolls under
a header/footer) replace static header/footer rules. The same 5–10% tint shift
is also the correct hover treatment — hover and grouping share one mechanism.

### 3. Nothing renders at rest

Row/section actions (`+`, kebab, drag handles) are invisible until hover or
focus-visible. Slack, Notion, and Linear all converged here.

- Every hover-revealed action MUST have a keyboard path (focus-visible reveals
  it) and a touch path (visible on mobile, or long-press/context menu) —
  WCAG 2.2 §2.5.7 for drag specifically
- Reserved gutters for hidden actions should be minimal; a vertical kebab (⋮)
  needs less width than horizontal (⋯). **Vertical kebab is the row-overflow
  convention; horizontal meatballs belong in toolbars/tables.**

### 4. One glyph, two jobs

Overload existing chrome before adding chrome. Canonical instance: a section
header's identity icon **becomes the collapse chevron on hover** (Slack).
Related: Alt/Option-click a chevron collapses **all** sections (Slack and
Linear both). A collapsed container keeps its signal — unread badges and
activity counts roll up onto the collapsed row (Discord folders).

### 5. One row grammar for mixed item types

When a list mixes types (sessions, channels, DMs, agents), every row uses one
template: **fixed-size leading-glyph slot + single-line (or fixed two-line)
label + trailing meta/badge slot + hover kebab**. The glyph communicates the
type (avatar = agent/person, `#` = channel, face-stack = group DM); the row
chrome never changes. Attribution belongs in the label grammar:
`Agent › thing` — a session is never shown without whose it is.

### 6. Prediction is additive — never reorder the user's structure

NN/g spatial-memory research: auto-reorganizing navigation breaks wayfinding
and erodes trust. Production pattern everywhere (Slack priority sort, Spotify
pins, VS Code recents): recency/frequency may rank a **dedicated additive
layer** (Jump Back In / Today), while manual structure (channels, pins, groups)
stays exactly where the user put it. Manual overrides are stored separately and
never silently discarded.

### 7. Personal scope floats above structure

The "where am I needed?" answer sits above all browsing structure: Linear's
Inbox/My Issues pattern. For DorkOS this is the **Now / Attention** surface —
permission prompts, mentions, wedged/idle sessions — always first, never
collapsible into oblivion, badge-counted.

### 8. Progressive disclosure by data volume, not settings

Chrome appears when the data earns it: grouping UI appears at ~8+ agents or 2+
runtimes (already right in the sidebar); folders/sections/filters stay
invisible below threshold (Telegram, Notion, Discord). Onboarding surfaces
(suggested actions) retire themselves as each suggestion is completed. Never a
settings toggle for "advanced mode."

### 9. Agents get their own status vocabulary

Agent state is not human presence. From Buzz's production design:

- Agent "working" is visually distinct from human "typing" and never shares
  its UI slot
- Parallel activity aggregates: "**N agents working**" as one calm line, not N
  pulsing rows
- Status is composed: process state × heartbeat × activity. "Running but
  silent past a grace period" renders as _starting/wedged_ (a warning), not
  offline
- Live activity verbs ("reviewing PR…", "writing tests…") are the highest-value
  glanceable signal a fleet UI can show

### 10. Mobile is a different app, not a squeezed sidebar

- Aggressively cut destinations: 3 bottom tabs + More (Slack went 5→3;
  Discord runs 3)
- No FAB in this app category — creation lives in headers or a tile strip
- Gestures and long-press replace hover entirely
- Bulk actions ("catch up", mark-all-read) replace per-item hover triage
- ⌘K/command palette **augments** navigation, never replaces it (palette-only
  nav fails discoverability)

## Micro-conventions adopted

- Section labels: sentence case, 12px medium, muted — not ALL-CAPS tracking
  (caps + letterspacing reads dated at small sizes)
- Zone labels (landmark headings like Now/Today/Library) are **not** collapse
  controls; only sections inside them collapse — never nest accordions
- One indent level max in nav trees; depth beyond 2 doesn't aid wayfinding
  (NN/g)
- Unread: bold label + dot for activity; numbered badge reserved for direct
  mentions/needs-you (two-tier, Slack/Discord convention)
- Empty ≠ empty-looking: a zone with nothing to say disappears; it does not
  render an empty box. Absence is the calm signal.
- Every surface keeps a help affordance; ours is **Ask DorkBot** (seeded
  session), not a docs link dump.

## Where the current codebase contradicts this (audit findings, 2026-08-09)

| Finding                                                                           | Rule violated           |
| --------------------------------------------------------------------------------- | ----------------------- |
| Sidebar stacks 30px left inset (12+8+10)                                          | 1                       |
| `border-b` under nav header, `border-t` above footer                              | 2                       |
| `+` on Channels/Agents always visible; DMs has none                               | 3                       |
| `MoreHorizontal` in all 4 row/section menus, gutter `pr-7`                        | 3                       |
| Chevron always visible, purely decorative                                         | 4                       |
| Three separate row implementations (session/room/agent); recents lack attribution | 5                       |
| ALL-CAPS `tracking-wider` section labels                                          | micro                   |
| Footer spends ~3 rows on branding                                                 | 1, micro                |
| Two duplicate header components (`SidebarSectionHeader`, `GroupHeader`)           | consistency (AGENTS.md) |

## Proposed skill/doc updates (not yet applied)

1. **`designing-frontend` skill** — add the two-spatial-modes rule (§1); the
   current "Generous space" principle, read without nuance, produced the 30px
   inset. Add "tint, not lines" (§2) and "nothing renders at rest" (§3) to the
   design rules table. Add the agent-status vocabulary (§9) — it exists nowhere
   in the design docs today.
2. **`styling-with-tailwind-shadcn` skill** — add control-surface tokens: the
   canonical dense row (`h-7`/28px, `text-[13px]`, 16px inset), hover-reveal
   pattern (`opacity-0 group-hover:opacity-100 focus-visible:opacity-100`),
   scroll-edge shadow recipe, and kebab-not-meatballs guidance.
3. **`contributing/design-system.md`** — reconcile with §1/§2; document the
   two-tier unread convention and zone-vs-section semantics.
4. New shared primitive when the sidebar work lands: one `SidebarRow` + one
   `SectionHeader` (replacing the duplicated pair), encoding rules 3–5 once.

## Sources

- Slack: custom sections & sidebar prefs help docs; iOS 26 redesign posts;
  slack.design "Re-designing Slack on Mobile"
- Linear: "How we redesigned the Linear UI (part II)"; changelogs 2024-12-18
  (personalized sidebar), 2025-03-19 (collapsible sections)
- Discord: Server Folders 101; Android navigation engineering blog
- Notion: sidebar navigation help docs
- Arc: Auto Archive help doc (12h default; tiered persistence)
- Superhuman: Split Inbox help; "Speed as the Product" teardown
- Raycast: manual — navigation ("search + act")
- Buzz (Block): repo-local source research `20260729_buzz-presence-signals.md`,
  `20260727_buzz-conversational-behavior.md`
- NN/g spatial-memory findings via `20260716_cross_app_sidebar_organization_patterns.md`
- Trend surveys: Tubik "UI Design Trends 2026", Midrocket 2026 guide,
  Atlassian spacing foundations
