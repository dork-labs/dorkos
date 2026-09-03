---
covers:
  - 'fix(server,shared,db): only the owner renames or archives a room (DOR-608)'
---

### Fixed

- Renaming a room, changing its topic, or putting it away is now yours alone. An agent in the room could do any of those over the API before — including archiving a channel, which takes it off everyone's sidebar. Agents can still rename a channel they belong to and write its topic through the `update_room` tool, which has never been able to archive anything, and an agent asking for its own direct message again still brings that conversation back (DOR-608)
