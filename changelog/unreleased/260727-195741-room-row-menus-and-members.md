---
covers:
  - 'feat(rooms): context menus and a members panel for channels and DMs (DOR-572)'
---

### Added

- Channels and direct messages now have a menu, on right-click and on the "…" button beside the row: mark as read, add agents, members, rename, edit topic (channels), and archive. It matches the menu agent rows already have.
- A members panel shows who is in a room, lets you add or remove agents, and — for the first time — lets you choose when each agent replies there: to everything, when spoken to, only when @mentioned, or not at all. Until now that setting was fixed the moment an agent joined.
- On a one-to-one conversation, the menu has a shortcut straight to that agent's profile.

### Changed

- Renaming a channel now changes its `#name` too. Before, the new name was saved but the sidebar kept showing the old one.
- Archiving a room asks first, and the confirmation comes with an Undo so you can bring it straight back.
