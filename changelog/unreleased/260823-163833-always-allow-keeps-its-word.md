---
covers:
  - 'fix(server): "Always Allow" keeps its word after the chat restarts (DOR-1316)'
  - 'fix(server): "Always Allow" never quietly hands a chat full power (DOR-1316)'
---

### Fixed

- Clicking "Always Allow" on a file change now sticks. It used to stop the asking only until the chat restarted. After that the agent asked again, while the status line still read "Accept edits". Your chat now remembers the change you made, so the status line and the agent finally agree (DOR-1316)
- One click on one file can never turn the asking off for good. Moving a chat to full power still takes the confirmation step it always did (DOR-1316)
