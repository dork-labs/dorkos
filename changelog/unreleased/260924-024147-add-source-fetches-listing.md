---
covers:
  - "feat(marketplace): fetch a new source's listing when it is added (DOR-2304)"
  - "fix(marketplace): keep a new source's listing honest and show it in the app (DOR-2304)"
---

### Changed

- Adding a marketplace source now fetches its list of packages straight away, so you can install from it without running `dorkos marketplace refresh` first. If DorkOS can't reach the source right then, the source is still added, and `dorkos marketplace add` tells you why the list isn't there yet and the command that tries again. In the app, the sources page shows the same reason on the source's row, with a **Try again** button, and each source now has a **Refresh** button. A refresh always checks again: if the source can't be reached, the terminal and the app say so and tell you when the copy they're still showing is from, instead of calling it refreshed. Source names can now use only letters, numbers, dots, dashes and underscores. Removing a source also forgets its list of packages, so a new source you give the same name never shows the old one's packages (DOR-2304).
