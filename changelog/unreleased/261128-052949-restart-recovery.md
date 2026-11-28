---
covers:
  - 'feat(runs): after a restart, each cut reply is decided once, and nothing jumps ahead of it (DOR-5234)'
---

### Added

- When DorkOS restarts during a reply, the chat now says what happened to it, and your inbox gets one note: the reply stopped and you can send a message to continue, or it was waiting on your answer. A message the agent may not have read before the restart comes back to your composer as a draft, never sent twice. Messages queued behind that reply wait until it is sorted out, then run in your order (DOR-5234)
