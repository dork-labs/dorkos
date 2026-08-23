---
covers:
  - 'fix(cli): a failed room export cleans up its staging folder (flaked pre-push repo-wide)'
---

### Fixed

- When `dorkos room export` loses its connection part-way, it no longer leaves a stray `.dorkos-export-…` folder next to the file you were saving. The export still stops and tells you it is not complete, and the copy you already had is still untouched — now the scratch folder goes away too
