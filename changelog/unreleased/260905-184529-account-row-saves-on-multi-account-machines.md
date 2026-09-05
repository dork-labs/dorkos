---
covers:
  - 'fix(client): the Account row saves through the operator route (DOR-1736)'
---

### Fixed

- Switching which account an agent runs on now saves on machines with more than one account. The Account setting in an agent's "Runs on" panel was sending its change down a path that only agents use, and that path refuses account changes on purpose — only you get to decide whose subscription pays. So the setting quietly failed every time, on the only machines that show it. It now goes the way the rest of your settings go, and the picker keeps whatever you chose (DOR-1736)
