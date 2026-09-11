---
covers:
  - 'fix(connections): remove disconnected accounts without erasing history'
  - 'fix(connections): close legacy disconnect authority before provider calls'
  - 'fix(connections): reconnect and remove disconnected accounts safely'
---

### Fixed

- Reconnect disconnected accounts through a fresh sign-in. If disconnection still needs to finish, Accounts now explains the next step. Old agent permissions stay revoked (DOR-1993).
- Keep disconnected accounts in their own section and let you remove them from Accounts after disconnection finishes. Past usage remains available (DOR-1994).
