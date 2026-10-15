---
covers:
  - 'fix(runtime): avoid unnecessary parsing and eager SDK loading'
---

### Fixed

- Load the Claude SDK when needed and refuse retired turns before starting a query.
- Skip unnecessary parsing in the focus-ring check while preserving encoded class detection.
