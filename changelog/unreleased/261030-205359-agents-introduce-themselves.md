---
covers:
  - 'feat(server): agents introduce themselves when they join a channel (DOR-2106)'
  - 'fix(server): introductions run at the runtime default level, five an hour per agent (DOR-2106)'
---

### Added

- Agents introduce themselves when you create a channel with them in it, or add one to a channel later. The channel says "Ana joined this room.", then Ana posts a sentence or two about who it is and what it can help with. Each agent does this once per channel, never again after a restart or if it leaves and comes back, and no agent replies to another's introduction. It uses the channel's normal hourly allowance of automatic replies, so a busy agent or a channel that has used its allowance just gets the "joined" line. An introduction runs at the default permission level of the agent's tool, never the agent's own level, and an agent introduces itself at most five times an hour. Direct messages, #team and chats bridged from another app are left alone. (DOR-2106, FB-33)
