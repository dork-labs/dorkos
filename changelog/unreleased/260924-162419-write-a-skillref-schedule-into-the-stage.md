---
covers:
  - 'fix(server): write a skillRef schedule into the staged tree before its record (DOR-2318)'
---

### Fixed

- Updating a package that schedules one of its own skills no longer says you changed that skill when you hadn't, and no longer leaves a stray `.dork-old` copy. Uninstalling the package now removes the scheduled skill instead of leaving it behind (DOR-2318)
