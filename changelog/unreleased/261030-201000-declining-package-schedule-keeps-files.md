---
covers:
  - "fix(server): declining a package's schedule keeps the package's files (DOR-2097)"
---

### Fixed

- Declining or deleting a schedule that came with an installed package no longer deletes part of that package. The schedule stays switched off and asks again only if the package changes it (DOR-2097)
