---
covers:
  - 'perf(server): settle independent checkbox file and manifest reads together'
---

### Changed

- Recover pending document checkbox writes with less filesystem wait while preserving source and grant validation.
