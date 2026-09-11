---
covers:
  - 'feat(rooms): render dorkos-ui widget fences in room messages (DOR-1997)'
---

### Added

- See the widgets your agents post in a channel or a direct message. A widget an agent writes into a room message now renders as the real card, table, or chart it describes, instead of a block of raw code. Buttons that change something in DorkOS, or open a link, work the same as they do in a session; buttons that would send a note back to the agent are shown but switched off, because a room message has no session behind it to answer into (DOR-1997)
