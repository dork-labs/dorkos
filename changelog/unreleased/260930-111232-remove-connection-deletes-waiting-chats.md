---
covers:
  - "fix(relay): delete a removed connection's unclaimed chats, blocked and ignored ones too (DOR-2608)"
---

### Changed

- Removing a Telegram or Slack connection, or uninstalling the package it came from, now also deletes the chats that reached it without an agent to answer them, with the sender names and chat titles they held. That includes chats you ignored or blocked, so if you set the same connection up again, someone you blocked can show up as waiting again. Updating a package keeps them. (DOR-2608)
