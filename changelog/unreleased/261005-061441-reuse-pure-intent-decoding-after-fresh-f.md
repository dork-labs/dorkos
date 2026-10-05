---
covers:
  - 'fix(canvas): reuse pure intent decoding after fresh full-row reads'
---

### Fixed

- Reduce repeated work when checking pending document checkbox writes. Every check still reads the current records.
