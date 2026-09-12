---
covers:
  - 'feat(claude-code): refuse asks at once on scheduled runs instead of waiting ten minutes'
  - 'feat(tasks): name every ask a scheduled run could not get answered'
  - 'feat(client): say what a scheduled run does with an ask nobody can answer'
---

### Changed

- A task running on its timer no longer waits ten minutes for an approval nobody can give. It moves on without that tool right away, and the run tells you what it skipped.
- A finished run leads with the tools it could not use, and each one gets its own line in your activity feed. Nothing pings your phone about it.

### Fixed

- Clicking **Run now** on a scheduled task keeps its approval cards. You are watching that one, so you can answer it — only runs the timer starts skip the asking.
