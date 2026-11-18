---
covers:
  - 'fix(rooms): preserve chat settings during recovery (DOR-4328)'
  - d35370a
  - 12140a8
  - 72dd46c
---

### Fixed

- Recover room posts after a Claude server error. Recovery works only until the server restarts.
  Fresh chats keep the original account, model, folder access and permission limits.
- Explain when a room chat stopped, with a next step for posting again.
