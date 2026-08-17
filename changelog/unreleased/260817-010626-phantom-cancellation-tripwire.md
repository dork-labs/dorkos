---
covers:
  - 'feat(server): the phantom-cancellation detector counts and warns on the persistent path (P5.2, DOR-1288)'
---

### Added

- `dorkos debug phantoms` shows how often an agent's own work was cut short by the coding tool rather than by you. This has been a real bug — one session lost eight pieces of work to it in a single sitting — and until now the only way to notice was to sit and watch. Now it is a number you can check, and a warning in the log when it happens (DOR-1087).
