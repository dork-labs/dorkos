---
covers:
  - 'fix(relay): close the loop-guard gap for thinking_delta/tool_progress/system_status (DOR-804)'
  - "fix(relay): derive the loop guard's set from StreamEventTypeSchema, closing the class (DOR-804 follow-up)"
---

### Fixed

- Fixed a case where an agent's own thinking or progress updates could be mistakenly re-delivered to it as a new message — closed for every kind of update this can happen to, not just the ones already seen
