---
title: 'Sidebar simplification: two levels, one door, sections, one bottom slot'
id: 260819-203828
created: 2026-08-19
status: ideation
design-session: .dork/visual-companion/88892-1787170146
review: research/20260819_sidebar-simplification-review.md
---

# Sidebar simplification

## Problem

The Heads up / Today / Library sidebar (spec `sidebar-now-today-library`,
2026-08-09) got the model right and the code is in good shape. What a person
sees is still harder than it needs to be:

- **Hierarchy reads flat.** Zone labels start at 16px, section headers at 36px,
  and _every_ row label at 42px, so a Today row and a channel row sit on one x
  while a header sits 6px left of its own rows. Two header styles for three
  depths. "Library" is a word with no referent on day one.
- **Two doors to one agent.** The same agent appears under _Direct messages_ (a
  DM room) and under _Agents_ (a session) and clicking each does a different
  thing. A 1:1 DM is a session in disguise — same folder, same runtime — that
  renders final text only. `specs/rooms` §8.5 predicted this and named the exit.
- **Groups are more capable than they look.** They already hold channels and
  DMs (DOR-581) but are called "Agent group", render _under_ Agents, and are
  gated on 8+ agents. Two of their controls do nothing.
- **The bottom of the panel is invisible or nagging.** Promo cards sit inside
  the scroller, have no dismiss control, and one of them is set to show always;
  on day one four cards compete under the list.
- **The list grows forever.** Every agent is a row, and an agent is also a
  project, so cold projects cost a row for good.
- **Small lies.** Four roll-up rows look pressable and do nothing; "Chat with
  X" and "Message" open a session; a 2-face DM stack spills out of the gutter.
- **First paint is not yet a moment of polish** (traced separately; see
  design-decisions §6).

## Direction chosen (2026-08-19, visual-companion session)

Four decisions, each picked from two options on `02-sidebar-review.html`:

1. **1B · Two levels, one header style.** Heads up, Today, Channels, Direct
   messages, Agents share one small muted header; rows indent one consistent
   step; groups (→ sections) are the only nested level; the visible "Library"
   heading goes while its zone id, section ids, collapse keys and DnD zone ids
   stay (label-only, the DOR-1155 pattern).
2. **2A · The agent row is the one door; sessions are the conversation.** Pick
   one agent anywhere → a session. Pick two or more → a group conversation.
   Hand-made 1:1 DMs stop being created; agent-initiated or bridged 1:1 DMs
   surface in Today with a dot (and a dot on the agent row), not as a standing
   second list. "Chat with X" / "Message" become "Open session".
3. **3A · Sections are top-level and hold anything; Agents shows recent +
   pinned.** "Agent group" → "Section"; sections are peers of Channels / Direct
   messages / Agents and take any Library row; always offered. Agents lists
   recent + pinned + grouped (~8) then one live row "All N agents →" (Team).
4. **4A · One bottom slot.** Pinned above the footer, a sibling of the
   scroller; one card at a time by priority (getting-started progress, update,
   profile prompt, promo); × always; dismissal persisted in config.

Plus: the motion direction in the review (§4.4) is approved as written, and
**the initial load must be extremely polished** — traced and decided in
design-decisions §6.

The full decision record is in [design-decisions.md](design-decisions.md). The
evidence (measurements, traces, bug table, Linear sweep) is in
`research/20260819_sidebar-simplification-review.md`.

## Non-goals

- No change to the Heads up / Today _model_ (rules, caps, holds, overnight
  archive, digest) — only their header chrome.
- No change to storage: rooms stay rooms, sessions stay sessions (ADR
  260808-140954 stands). 2A removes entry points; it does not merge transcripts.
- No nesting beyond one level; no sessions/workspaces/tasks in sections
  (sessions are time-ordered; the other two have no sidebar row yet).
- No smart-section rules over non-agent kinds.
- No "DM is the door" (2B) — the north star once rooms can render the engine,
  not the move for launch.
- No new onboarding tour.

## Open items before SPECIFY

- Fold-all-headers: do Heads up / Today collapse like the rest? (proposed: yes,
  with the roll-up count on the folded header)
- "Recent" threshold for the Agents list (proposed: the existing `inactive`
  attention boundary, tightened to 7 days of _your_ activity, floor of 8 rows)
- Bottom-slot priority order (proposed: getting-started progress > update pill >
  profile prompt > promo)
- Mobile tab label for the old "Library" panel ("Library" as a place name, or
  "All")
- Tidy of existing empty hand-made 1:1 DMs (archive once on upgrade, or leave)
- `remote-access` promo: real trigger or delete
- Which of the Wave 0 honesty fixes ship ahead of the spec (proposed: all of
  them — none depends on a design decision)

## Related

- `specs/sidebar-now-today-library` (BC-1..3, BC-28..35, BC-45 amended by this)
- `specs/sidebar-groups`, `specs/smart-agent-groups` (rename + top-level render)
- `specs/feature-promo-system` (dismiss regression, slot placement)
- `specs/rooms` §8.5 / §14.4 (the convergence it predicted; "a DM has no cwd"
  is false in code)
- `specs/unified-conversation` (the surfaces are already one compound; 2A is
  the entry-point half it left open)
- Linear: DOR-1105, DOR-1098, DOR-906, DOR-1143, DOR-772, DOR-1097, DOR-1094,
  DOR-588, DOR-341, DOR-329 (close), DOR-654, DOR-1220, DOR-603
