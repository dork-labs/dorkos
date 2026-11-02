---
covers:
  - "fix(runtime): a slow agent start is not an unreadable sign-in, and every start's time is logged (DOR-3670)"
---

### Fixed

- When an agent took a little longer than usual to start again, DorkOS stopped it after 15 seconds and said "Agents can't read their sign-in. Check this Mac for a password prompt." Agents now get the normal minute to start, and a slow start says "The agent took too long to start. It will try again." The sign-in message now appears only when reading your sign-in really is stuck.
