---
covers:
  - 'fix(feedback): keep the newest log lines in a bug report (DOR-1976)'
---

### Fixed

- A bug report's attached server log now keeps the lines from just before the problem, instead of the oldest ones. On a busy machine the log was long enough to be trimmed, and it trimmed from the wrong end, dropping exactly the lines that explain what went wrong (DOR-1976).
