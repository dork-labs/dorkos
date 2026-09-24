---
covers:
  - "feat(marketplace): fetch a new source's listing when it is added (DOR-2304)"
---

### Changed

- Adding a marketplace source now fetches its list of packages straight away, so you can install from it without running `dorkos marketplace refresh` first. If DorkOS can't reach the source right then, the source is still added, and `dorkos marketplace add` tells you why the list isn't there yet and the command that tries again. This works the same from the terminal and from the Marketplace sources page in the app (DOR-2304).
