---
covers:
  - 'fix(server): stopping an agent now has a deadline on OpenCode too (DOR-1299)'
---

### Fixed

- Stopping an agent now has a deadline on every engine DorkOS can run — including OpenCode,
  where a stuck helper could previously make Stop wait forever. If OpenCode doesn't answer
  within a few seconds, DorkOS gives up and tells you honestly, instead of leaving the Stop
  button spinning (DOR-1299).
