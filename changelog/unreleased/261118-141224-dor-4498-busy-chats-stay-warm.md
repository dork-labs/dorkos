---
covers:
  - 'fix(runtime): a busy chat keeps its process between turns, so its tools stop dropping (DOR-4498)'
  - "fix(runtime): a person's turn never waits behind the reclaim grace, and memory decides the warm ceiling (DOR-4498)"
  - 'fix(runtime): a launch with no turn opening skips the reclaim grace (DOR-4498)'
  - "fix(runtime): a person's launch does not queue behind agent launches waiting on a grace (DOR-4498)"
---

### Fixed

- When more chats are busy than DorkOS keeps running at once, a chat that just finished a turn now keeps its process for two minutes. Before, another chat could take it right away, so busy chats restarted almost every turn and all their tool servers disconnected and started again, slowing the whole computer. Work an agent started now waits for a free spot instead, and says so. A message you send never waits for this (DOR-4498)
- When the number of chats DorkOS keeps running is lower than the number of chats agents may run, DorkOS now notes it in its log, so restarts have a reason you can find (DOR-4498)
