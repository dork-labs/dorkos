---
covers:
  - 'feat(rooms): context menus and a members panel for channels and DMs (DOR-572)'
  - 'fix(rooms): confirm a removal in place, so the panel survives answering it'
  - 'fix(rooms): three defects review found by driving the menus (DOR-572)'
  - 'fix(rooms): an archived channel can come back under a new name (DOR-572)'
---

### Added

- Channels and direct messages now have a menu, on right-click and on the "…" button beside the row: mark as read, add agents, members, rename, edit topic (channels), and archive. It matches the menu agent rows already have.
- A members panel shows who is in a room, lets you add or remove agents, and — for the first time — lets you choose when each agent replies there: to everything, when spoken to, only when @mentioned, or not at all. Until now that setting was fixed the moment an agent joined.
- On a one-to-one conversation, the menu has a shortcut straight to that agent's profile.

### Changed

- Renaming a channel now changes its `#name` too. Before, the new name was saved but the sidebar kept showing the old one.
- Archiving a room asks first, and the confirmation comes with an Undo so you can bring it straight back. If the Undo can't work — someone took the name meanwhile — it now says so instead of a blank "Action failed".
- A channel you archived can come back under a different name when something else took its old one. Before, it could not come back at all.
