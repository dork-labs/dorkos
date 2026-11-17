---
covers:
  - 'fix(auth): turning on a chat connection that is already on changes nothing (DOR-4355)'
---

### Security

- Asking to turn on a chat connection that is already on no longer touches it, so it can't undo you switching it off at the same moment.
