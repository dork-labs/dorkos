---
covers:
  - 'fix(marketplace): undo only what a failed adapter install created (DOR-2607)'
  - "fix(marketplace): say up front when a connection already uses a package's name (DOR-2607)"
  - 'fix(marketplace): reinstall an installed adapter package without touching its connection (DOR-2607)'
---

### Fixed

- If you already have a connection with the same name as a marketplace package, the install preview now says so before you install, and asks you to remove or rename it first. Your connection stays exactly as it was. Before, the install failed at the last step and removed your connection, along with its saved sign-in details and its links to your agents. (DOR-2607)
- Installing an adapter package you already have installed now works, and keeps its connection, saved sign-in details and links to your agents as they were. (DOR-2607)
