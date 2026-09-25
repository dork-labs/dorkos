---
covers:
  - 'fix(client): keep empty states hidden while the boot cache restores (DOR-1914)'
---

### Fixed

- Opening the app no longer flashes "nothing here" messages over things you already have. For a moment during startup, the Team page's table and map views could show "Bring in existing projects" over a full team, and the side panel, marketplace sources and agent gallery could briefly say they were empty. They now show their loading state until your data is in (DOR-1914)
