---
covers:
  - 'fix(community): queue legal holds before the next purge deletion'
---

### Fixed

- Finish only the file already being deleted when a legal hold is placed during a community purge. Preserve the remaining files and community records.
