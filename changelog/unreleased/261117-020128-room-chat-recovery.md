---
covers:
  - 'fix(rooms): preserve chat settings during recovery (DOR-4328)'
  - d35370a
  - 12140a8
  - 72dd46c
  - "fix(rooms): hand-off decline reasons fit the room notice, in the designer's words (DOR-4328)"
---

### Fixed

- Room posts now recover after a Claude server error, until DorkOS restarts. The new chat keeps
  the original account, model, folder access and permission limits.
- When a room chat stops, DorkOS says why and what to do next.
