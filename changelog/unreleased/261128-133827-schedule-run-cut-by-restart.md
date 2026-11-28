---
covers:
  - 'feat(runs): a scheduled run a restart cut ends with what happened to its turn, told once (DOR-5496)'
---

### Fixed

- When DorkOS restarts in the middle of a scheduled run, the schedule's run history now says how that run ended, and you hear about it once instead of getting a second notice about a stopped reply. A run from more than a day ago is recorded quietly, and nothing wakes for it. (DOR-5496)
