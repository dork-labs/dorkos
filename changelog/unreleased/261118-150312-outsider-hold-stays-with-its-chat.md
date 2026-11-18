---
covers:
  - 'fix(turn-power): an outsider hold stays with the chat that read the words, and your own next message clears it (DOR-4698)'
---

### Fixed

- Your agents no longer pass the "read words from outside your team" hold to each other when none of them read such words. Before, one held chat could hold every message its agent sent from any chat, and the hold spread from agent to agent. It then refused things it shouldn't, such as handing the Agent browser to you, changing settings, or editing memory.
- A message from another agent no longer keeps your direct chat held after you reply. Your own next message starts clean.
- A chat that really did read outside words, a Telegram or Slack chat with a stranger in it, or a chat DorkOS can't place still counts as held.
