---
covers:
  - "feat(marketplace): remember how each source's last fetch went (DOR-2324)"
  - 'fix(marketplace): newest fetch wins, the record keeps its count, and agents see it (DOR-2324)'
---

### Changed

- DorkOS now remembers how each marketplace source's last check went, whether it came from adding the source, a refresh, or browsing packages. On the sources page, a source whose packages didn't load keeps its amber dot and the reason after you reload the page, and every open window shows the same thing. A source that hasn't been checked yet gets a hollow grey dot instead of a green one. `dorkos marketplace list` has a new column showing how many packages each source has, and a line under the table says why any of them didn't load. Agents that list your marketplace sources see the same, so they can tell an empty marketplace from one that didn't load (DOR-2324).
