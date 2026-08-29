---
covers:
  - 'fix(relay,server): never log raw adapter errors that can carry access tokens (DOR-1509)'
---

### Security

- Connection errors from chat integrations can no longer write access tokens into log files.
