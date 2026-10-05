---
covers:
  - 'perf(server): reuse current checkbox source query compilation'
---

### Changed

- Reduce repeated query compilation during checkbox recovery while checking current document and session rows on every read.
