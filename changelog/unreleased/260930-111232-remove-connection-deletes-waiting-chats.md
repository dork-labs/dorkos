---
covers:
  - "fix(relay): delete a removed connection's unclaimed chats, blocked and ignored ones too (DOR-2608)"
  - 'fix(connections): refetch the claim feed after a removal, and say a block must be redone (DOR-2608)'
  - 'fix(marketplace): refetch the claim feed after uninstalling a chat-app package (DOR-2608)'
---

### Changed

- Removing a chat connection such as Telegram or Slack, or uninstalling the package it came from, now also deletes its list of people who messaged it with no agent to answer, with the names and chat titles in it. That includes people you ignored or blocked, so if you set the same connection up again, anyone you blocked will need blocking again. Updating a package keeps them. (DOR-2608)
