---
covers:
  - 'fix(schedules): "Try it once now" runs at the mode you picked when it is stricter (DOR-4336)'
---

### Fixed

- On a schedule's approval card, "Try it once now" now runs at the mode you picked when it's
  stricter. Before, it ignored your pick. The card names a different mode only when the test run
  can't use yours.
