---
covers:
  - 'fix(client): the make-default trust offer withdraws when you switch conversations (DOR-1237)'
---

### Fixed

- Changing how much one agent may do no longer risks changing your default. After you move the trust dial, DorkOS offers to make that the starting point for every new chat. That offer used to stay on screen when you switched to another conversation, where one click set a default from a choice you made somewhere else. It now goes away with the chat it belongs to (DOR-1237)
