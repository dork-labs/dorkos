---
covers:
  - 'fix(harness): a generated file is never seen half-written (DOR-1854)'
  - 'feat(harness): two syncs into one repo take turns (DOR-1854)'
---

### Fixed

- The files DorkOS writes for your coding agents now land in one step. If an agent reads one while a sync is running, it sees the whole old version or the whole new one — never an empty or half-written file (DOR-1854)
- Two syncs into the same project no longer trip over each other. Installing two packages at once could leave one of them waiting on a half-finished picture of your project, or fail outright with an error there was nothing you could do about (DOR-1854)
