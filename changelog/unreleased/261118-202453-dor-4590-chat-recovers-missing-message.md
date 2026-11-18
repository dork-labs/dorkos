---
covers:
  - 'fix(runtimes): a chat whose resume point is gone picks up again instead of failing every turn (DOR-4590)'
---

### Fixed

- A chat that fails with "No message found with message.uuid" now works again on your next
  message, so if you see it, send your message again. Before, every message failed the same way
  until DorkOS stopped restarting the chat.
