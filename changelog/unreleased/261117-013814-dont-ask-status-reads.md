---
covers:
  - "fix(tasks): a Don't ask schedule can read which chats run and how its runs went (DOR-3971)"
---

### Fixed

- A schedule set to Never ask can now check on things. It can see which chats are running, read a schedule's past runs, see when each agent last worked, and read an agent's heartbeat. Before, it was refused these simple reads. To keep other people's words out, it sees no chat titles, no run summaries and no heartbeat summaries. Everything else it was refused before is still refused.
