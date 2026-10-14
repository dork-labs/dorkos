---
covers:
  - 'fix(server): keep renewing the credits token after a failed refresh (DOR-2915)'
---

### Fixed

- When DorkOS Cloud had a brief outage just as your credits token was due to renew, DorkOS stopped trying. Your next chat on credits then had to wait for a new token, or failed. Now DorkOS keeps trying, waiting a little longer each time.
