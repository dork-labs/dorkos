---
title: 'Sidebar redesign: Now / Today / Library'
id: 260809-143358
created: 2026-08-09
status: ideation
design-session: .dork/visual-companion/19627-1786276365 + .dork/visual-companion/9729-1786282982
---

# Sidebar redesign: Now / Today / Library

## Problem

The current sidebar is a type-organized list (nav, Jump Back In, Channels, DMs,
groups, Agents, footer) with accumulated issues: 30px stacked left inset, dated
separators (hairline borders), always-visible chrome (`+`, decorative chevrons,
horizontal `⋯`), no child indentation, scattered create actions across three
menus, inconsistent recents rows that never say whose session they are, and a
footer that spends three rows on branding. Beyond the cosmetics, it answers the
wrong question: it shows _what exists_ instead of _where you're needed_ — the
core question for an operator running many agents.

## Direction chosen

**Now / Today / Library** — the sidebar reorganizes around time and urgency
instead of item type, with a stable Library preserving spatial memory:

- **Now** — what needs you + what's working. Auto-populated, capped, disappears
  entirely when empty.
- **Today** — one unified recents stream (sessions, channels, DMs) with the
  active conversation pinned on top. Quiet items archive overnight into ⌘K.
- **Library** — stable, manual, yours: Channels / Direct messages / Agents (with
  groups inside), plus Pins on top.

This was chosen over "A · Tighten" (fix issues in place) and "B · Mission
control" (attention inbox + restructure) in a visual-companion session on
2026-08-09, deliberately accepting a relearning cost while the product is in
beta. B's best elements (the New button, live agent verbs, attention-first
thinking) were folded into C.

The full decision record, mockup-by-mockup, is in
[design-decisions.md](design-decisions.md). The codified design meta that
drives every visual choice is
[research/20260809_design-meta-2026-learnings.md](../../research/20260809_design-meta-2026-learnings.md).

## Open items before SPECIFY

- ⌘K / command palette design pass (in progress — C depends on it for recall)
- Workspace concept audit (in progress — the word is overloaded; row grammar may
  need workspace context)
- Notification rules table (bold vs badge vs Now membership; mute semantics)
- Dark-mode calibration of tint-based separation
- Accessibility spec (zone landmarks, roving tabindex, Now live-region)
- Drag-and-drop scope in the new structure
- Obsidian EmbedSidebar mapping
