---
covers:
  - 'fix(server): send the model body OpenCode compaction requires (DOR-1668)'
---

### Fixed

- `/compact` now works on OpenCode sessions. It had been failing every time with a "bad request" error from OpenCode, because DorkOS never said which model should write the summary. DorkOS now names the session's own model, so compacting an OpenCode session shortens the conversation the way it does in Claude Code (DOR-1668)
