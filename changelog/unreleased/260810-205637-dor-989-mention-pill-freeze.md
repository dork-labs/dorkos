---
covers:
  - "fix(client): mentions already on screen follow the room's roster (DOR-989)"
---

### Fixed

- Rename an agent, or watch someone leave a room, and every `@mention` of them already on
  screen now updates to match. They used to keep whatever name the roster had the moment
  the message was first drawn, so a room left open could go on calling somebody by a name
  they no longer had (DOR-989)
