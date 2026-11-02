---
covers:
  - 'fix(sessions): reclaim idle records when starting chats at capacity (DOR-3682)'
  - 'fix(sessions): session_start describes the running-chats tool instead of naming it (DOR-3682)'
---

### Fixed

- Start a Claude Code chat when old chats are idle, even after a busy hour. If all 50 chats are busy, DorkOS says to wait for one to finish.
