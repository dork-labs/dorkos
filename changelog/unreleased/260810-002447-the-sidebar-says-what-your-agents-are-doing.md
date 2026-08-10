---
covers:
  - 'feat(client): the sidebar says what your agents are doing, once and honestly (P2.7, DOR-1072)'
  - "test(client): the ladder's table encodes the shipped rung, not the brief's (DOR-1096)"
  - 'fix(client): the second line keeps the preview it was about to swallow (DOR-1072 review)'
  - 'test(client): assert the measurement happened, not just that nothing did (DOR-1072 review 2)'
---

### Added

- Sidebar rows can now say what an agent is actually doing — "Editing RoomRow.tsx…",
  "Running pnpm test…", "waiting on you" — and say nothing at all when a session is idle.
  The rule is deliberately honest: if we do not know which tool is running, the row says
  "Working…", and if the turn is over it says nothing rather than leaving an old phrase up.
  A verb that outlives its turn is just a lie in a small font.

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
- Rows no longer lose their one-line preview. A quiet session and a busy channel both keep
  the last thing that happened there, instead of showing an empty line where it should be.
