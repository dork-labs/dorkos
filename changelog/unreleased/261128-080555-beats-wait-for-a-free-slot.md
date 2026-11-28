---
covers:
  - 'feat(heartbeats): a beat waits for a free chat slot instead of being refused (DOR-5216)'
---

### Changed

- When too many chats are running, an agent's heartbeat now waits for one to finish and then does its check-in, instead of skipping it with "Too many chats were running". If heartbeats are turned off while it waits, it is dropped and never runs late. (DOR-5216)
