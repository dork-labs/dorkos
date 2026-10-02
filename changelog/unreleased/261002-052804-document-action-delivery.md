---
covers:
  - 'feat(canvas): deliver approved document actions when agents are ready'
  - 'fix(canvas): account for warning storage and preserve shutdown fences'
  - 'fix(canvas): preserve accepted waits and bound action checks'
  - 'chore(canvas): compose verified browser lifecycle for delivery'
  - 'fix(canvas): warn accepted actions waiting for a busy agent'
---

### Added

- Deliver approved document actions when the owning agent is ready. Actions wait while the agent is busy and resume after restart. (DOR-2665)

### Fixed

- Show a warning after an approved action has waited 15 minutes, while preserving its place in the queue. Keep action checks responsive as document history grows. (DOR-2665)
