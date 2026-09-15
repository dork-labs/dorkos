---
covers:
  - 'feat(client): a desktop tab on a channel reads "#general" (DOR-2072)'
  - 'fix(client): a room rename from elsewhere reaches an open channel tab (DOR-2072)'
---

### Fixed

- On the desktop app, a tab on a channel used to just say "Channels," no matter which one you had open. Now it reads "#general" (or a direct message's name), the way the channel itself does. It shows "Channels" until that name loads, so you never see the wrong one flash by, and it keeps up if someone renames the channel from another device or another agent renames it (DOR-2072)
