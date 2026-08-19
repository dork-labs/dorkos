---
covers:
  - "refactor(client): a session's Enter goes through its ConversationTarget, like a channel's (DOR-1354)"
---

### Changed

- The message box says "Still opening this conversation…" and holds your words while DorkOS is
  still working out which conversation you are in, instead of looking ready and quietly losing
  what you typed (DOR-1354)
