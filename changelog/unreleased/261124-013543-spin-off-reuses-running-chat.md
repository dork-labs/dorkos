---
covers:
  - 'fix(sessions): starting a chat for work one of your chats already has hands that chat back (DOR-3690)'
---

### Fixed

- When an agent starts a new chat for a ticket or pull request one of its own chats is already working on, it now gets that chat back instead of starting a second one. It can still ask for a second chat when it really wants one (DOR-3690).
