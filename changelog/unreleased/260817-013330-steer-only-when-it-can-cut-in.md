---
covers:
  - "fix(server,client,shared): Steer only appears when it can really cut in, and tells you when it couldn't (DOR-1268)"
---

### Fixed

- "Steer" now appears only when your chat can really hand a message to the agent mid-task. Before, it was offered on every Claude Code chat, but only chats that keep the agent running between messages can be interrupted that way — so the message quietly waited its turn instead of cutting in (DOR-1268)
- If a message can't cut in after all, the chat says so — "Couldn't cut in. Queued as your next message." — instead of staying silent
