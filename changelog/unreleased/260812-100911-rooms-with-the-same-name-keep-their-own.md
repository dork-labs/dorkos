---
covers:
  - 'fix(server,client): a conversation says which room it came from, by id (DOR-1157)'
---

### Fixed

- **Rooms with the same name no longer steal each other's conversations.** Two rooms can share
  a name — you can archive `#shipping` and start a fresh one, and a direct message can be
  titled `#general`. In ⌘K, picking one of them used to show the other one's work, and the
  room that lost the name showed nothing at all. Conversations now carry the room they came
  from, so each room shows exactly its own (DOR-1157)
