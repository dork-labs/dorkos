---
covers:
  - 'fix(relay): close the loop-guard gap for thinking_delta/tool_progress/system_status (DOR-804)'
---

### Fixed

- Fixed a rare case where an agent's own thinking or progress updates could be mistakenly re-delivered to it as a new message
