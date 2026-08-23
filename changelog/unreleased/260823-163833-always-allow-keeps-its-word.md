---
covers:
  - 'fix(server): "Always Allow" keeps its word after the chat restarts (DOR-1316)'
---

### Fixed

- Clicking "Always Allow" on a file change now sticks. It used to stop the asking only until the chat's process restarted — after that the agent asked again, while the status line still read "Accept edits". The chat now remembers the change you made, so what the status line says and what the agent does are the same thing (DOR-1316)
