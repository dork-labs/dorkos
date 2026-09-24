---
covers:
  - "feat(marketplace): remember how each source's last fetch went (DOR-2324)"
---

### Changed

- DorkOS now remembers how each marketplace source's last check went, whether it came from adding the source, a refresh, or browsing packages. On the sources page, a source whose packages didn't load keeps its amber dot and the reason after you reload the page, and every open window shows the same thing. `dorkos marketplace list` has a new column showing how many packages each source has, and a line under the table says why any of them didn't load (DOR-2324).
