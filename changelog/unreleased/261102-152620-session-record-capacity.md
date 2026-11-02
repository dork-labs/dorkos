---
covers:
  - 'fix(sessions): reclaim idle records when starting chats at capacity (DOR-3682)'
---

### Fixed

- Start a Claude Code chat when old chats are idle, even after a busy hour. If all 50 chats are busy, DorkOS says to wait for one to finish.
