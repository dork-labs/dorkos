---
covers:
  - 'feat(client): wire the verb ladder and avatar signals into SidebarRow (DOR-1072)'
  - 'feat(client): the welcome-back glow, once, on a row whose work finished while you were away'
  - 'fix(client): the chat status strip and the sidebar go through one verb function'
  - 'fix(client): a status dot says in words what it says in colour'
---

### Added

- Sidebar rows can now say what an agent is actually doing — "Editing RoomRow.tsx…",
  "Running pnpm test…", "waiting on you" — and say nothing at all when a session is idle.
  The rule is deliberately honest: if we do not know which tool is running, the row says
  "Working…", and if the turn is over it says nothing rather than leaving an old phrase up.
  A verb that outlives its turn is just a lie in a small font.
- A row whose work finished while you were away glows amber once when you come back, and
  only that row. It uses the same "how long is away" setting your agents already use before
  they greet you in your team channel — there is no second setting to find. If you have
  asked your computer for less motion, the glow does not appear at all.

### Changed

- The chat status strip and the sidebar now get their words from the same place. They could
  drift apart before, and briefly did: the strip used to make up a joke verb while the
  sidebar said nothing, so two parts of the same screen described one agent two ways.
- The coloured dot on an agent's face now says what it means out loud, so a screen reader
  announces "needs you" rather than nothing at all. Colour on its own was never enough, and
  a dot is nothing but colour.

### Fixed

- A row that is showing a live verb keeps its second line even when the reading behind it
  goes quiet for a moment. It used to collapse and grow back under your pointer.
