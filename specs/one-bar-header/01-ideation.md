---
id: 260821-202452
title: 'One Bar: header consistency across the cockpit'
status: ideation
created: 2026-08-21
linear: DOR-1399
design-session: .dork/visual-companion/3968-1787342816
---

# Ideation — One Bar

Ideation ran live with Dorian on 2026-08-21 through a visual-companion session rather than as a written exploration. The full record of the questions asked, options mocked, and choices made is in [design-decisions.md](design-decisions.md); the browser mockups are in the design session directory above.

## The problem, in one paragraph

The cockpit has four different header grammars. Most pages use the shared `PageHeader` one-row bar; the session page hand-rolls a breadcrumb ("Team › DorkBot › Session") that names neither the agent visually nor the session; channels stack a second identity row (`RoomHeader`) under a bar that already shows the same name; Home stacks three rows (bar + surface tabs + #team identity) — four on a phone. Tabs come in three visual styles (underline strip, pill row, mobile select box). Activity's filter chips sit two rows above the content they filter. And #team is reachable through two doors (`/` and `/channels?id=…`) with different chrome.

## Direction chosen

**One Bar** (option A of three explored): every page gets exactly one 36px header row. Details and the four sub-decisions (mobile overflow, the #team door, room management moving to a tabbed right panel, session identity, in-page H1s) are in design-decisions.md. The implementation contract is [02-specification.md](02-specification.md).
