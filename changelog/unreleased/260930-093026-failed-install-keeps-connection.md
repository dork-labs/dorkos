---
covers:
  - 'fix(marketplace): undo only what a failed adapter install created (DOR-2607)'
---

### Fixed

- When installing a marketplace package fails because you already have a connection with the same name, your connection now stays exactly as it was. Before, the failed install removed it, along with its saved sign-in details and its links to your agents. (DOR-2607)
