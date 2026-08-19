---
covers:
  - "refactor(client): a session's Enter goes through its ConversationTarget, like a channel's (DOR-1354)"
  - 'fix(client): a composer with no conversation behind it says so, instead of eating the message (DOR-1354)'
---

### Fixed

- In the Obsidian panel, typing before you have picked a conversation no longer swallows what you
  wrote. The message box now says "Pick a conversation, or start a new one." and keeps your words,
  instead of looking ready, clearing itself, and showing "Could not send message" (DOR-1354)
