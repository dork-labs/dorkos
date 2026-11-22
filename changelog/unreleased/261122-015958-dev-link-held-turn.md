---
covers:
  - "fix(marketplace): a turn that read outside words can't edit a folder you linked for development (DOR-4896)"
---

### Security

- A folder you linked for development runs its changes without asking. Now, in a chat that read words from someone other than you, like a shared room or Telegram, a Claude Code agent's file editing tools are blocked in that folder.
