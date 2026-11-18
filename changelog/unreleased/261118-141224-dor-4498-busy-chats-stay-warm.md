---
covers:
  - 'fix(runtime): a busy chat keeps its process between turns, so its tools stop dropping (DOR-4498)'
---

### Fixed

- When more chats are busy than DorkOS keeps running at once, a chat that just finished a turn now keeps its process for two minutes. Before, a new chat could take it right away, so busy chats restarted almost every turn and all their tool servers disconnected and started again, slowing the whole computer. A new chat now waits for a free spot instead, and says so (DOR-4498)
- When you haven't set how many chats stay running, DorkOS now keeps at least as many as agents may run at once, up to 32. If you set a lower number, DorkOS keeps it and notes in its log that chats may restart (DOR-4498)
