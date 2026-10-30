---
covers:
  - 'feat(server): the limit on chats agents start becomes a setting (DOR-3413)'
---

### Changed

- Your agents can run at most 8 chats they started on their own at the same time. That number used to be fixed. Now it is a setting, `runtimes.maxAgentChats`, so a computer with room to spare can allow more without waiting for an update: `dorkos config set runtimes.maxAgentChats 12`. When the limit is full, the message an agent gets now names the setting. Only a person can change it, never an agent.
