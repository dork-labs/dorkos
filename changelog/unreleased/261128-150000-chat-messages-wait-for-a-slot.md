---
covers:
  - 'feat(chat): chat messages start their turns through the turn port and wait for a free slot (DOR-5503)'
  - "fix(runs): a continuation does not carry a new direct chat's birth record (DOR-5503)"
---

### Changed

- When the computer is running as many agent chats as it allows, a message an agent sends to another agent's new chat no longer fails with "Not sent". It waits its turn and runs when a slot frees, and the agent is told it is waiting. A message waiting this way is kept if DorkOS restarts. (DOR-5503)
