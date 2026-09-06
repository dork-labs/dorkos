---
covers:
  - 'fix(client): the Account row saves through the operator route (DOR-1736)'
  - 'fix(client): the account sweep survives the popover that closed (DOR-1736)'
  - 'fix(client): the failure toast asserts the shape main actually renders (DOR-1736)'
---

### Fixed

- Switching which account an agent runs on now saves on machines with more than one account. The Account setting in an agent's "Runs on" panel was sending its change down a path that only agents use, and that path refuses account changes on purpose — only you get to decide whose subscription pays. So the setting quietly failed every time, on the only machines that show it. It now goes the way the rest of your settings go, the picker keeps whatever you chose, and every screen that names the account — the panel itself and the account label at the bottom of the window — updates straight away, even if you close the panel the moment you click (DOR-1736)
