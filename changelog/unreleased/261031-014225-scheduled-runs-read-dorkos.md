---
covers:
  - "fix(server): a scheduled run reads DorkOS's always-on tools at any mode (DOR-3373)"
  - "fix(server): a stranger's turn still asks before DorkOS's always-on reads (DOR-3373)"
---

### Fixed

- A scheduled task can check on DorkOS itself (whether it's up, its version, its extensions and their errors) at any permission level. Before, a task set to ask first, accept edits or never ask was refused those reads because nobody was there to approve them (DOR-3373)
