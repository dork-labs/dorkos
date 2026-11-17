---
covers:
  - "fix(tasks): a Don't ask schedule can read which chats run and how its runs went (DOR-3971)"
---

### Fixed

- A schedule set to Don't ask can now check on things. It can see which chats are running, read its own past runs, see when each agent last worked, and read an agent's heartbeat. Before, it was refused these simple reads. Everything else stays as it was: it still can't read messages, transcripts or the activity record, or change anything.
