---
covers:
  - 'fix(server): a partial patch into a nested manifest field leaves its siblings alone (DOR-1719)'
---

### Fixed

- An agent changing one of its own settings no longer quietly turns the ones beside it back on. Switching off its SOUL.md used to switch its saved notes back on, and nudging one personality dial reset the other five (DOR-1719)
