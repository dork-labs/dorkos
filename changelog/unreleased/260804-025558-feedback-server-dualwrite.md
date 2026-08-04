---
covers:
  - 'feat(feedback): server dual-writes submissions to the durable site route'
  - 'fix(feedback): truncate over-cap reporter identity before the durable write'
---

### Fixed

- Feedback and bug reports sent from the cockpit are now saved and turned into a tracked issue, not just counted for usage stats
