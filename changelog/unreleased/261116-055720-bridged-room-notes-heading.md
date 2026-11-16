---
covers:
  - 'fix(rooms): take a bridged chat’s name out of the ROOM.md heading DorkOS seeded, once (DOR-4453)'
---

### Security

- A bridged group's shared notes no longer start with the group's name. Anyone in a Telegram or Slack group can change that name, and the notes reach your agents on every turn. Notes made before this release are fixed the next time DorkOS starts and the notes have no unsaved changes. The heading becomes "Bridged channel", or the room's name if you renamed the room in DorkOS. If you changed the heading yourself, it stays as you left it (DOR-4453).
