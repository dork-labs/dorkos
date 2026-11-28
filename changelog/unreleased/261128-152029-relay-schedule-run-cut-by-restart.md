---
covers:
  - "feat(relay): a relay-carried schedule's turn names its task run, so a restart ends it from the run record (DOR-5508)"
---

### Fixed

- Every scheduled run that a restart cuts now ends the same way: its run history says how it ended, and you hear about it once. Before, some scheduled runs still got a second notice about a stopped reply. (DOR-5508)
