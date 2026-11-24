---
covers:
  - 'fix(sessions): starting a chat for work one of your chats already has hands that chat back (DOR-3690)'
  - 'fix: clearer chat and room states for retired, paused and already-running agents (DOR-2365, DOR-3178, DOR-3690)'
---

### Fixed

- When an agent starts a new chat from one of its chats, and the title or reason names a ticket or pull request another of its chats is already working on, it now gets that chat back instead of starting a second one. It can still ask for a second chat when it really wants one. Work you queue yourself is never turned away (DOR-3690).
