---
covers:
  - 'fix(tasks): a failing schedule sends one notice, not one per run (DOR-3123)'
---

### Fixed

- A schedule that starts failing sends one notice that names the refused tools and the fix. No more arrive until it works and then breaks again.
