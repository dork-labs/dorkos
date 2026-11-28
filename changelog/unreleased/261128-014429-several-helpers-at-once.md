---
covers:
  - 'fix(runtimes): several helpers finishing at once no longer end the chat in an error (DOR-2829)'
  - "fix(runtimes): a message waits for the agent's answer to several reports, even when it was queued behind your turn (DOR-2829)"
  - "fix(runtimes): a new message waits for the agent's open turns before the queue hands them the session (DOR-2829)"
---

### Fixed

- When several of a Claude Code agent's helpers finish at the same moment and a message arrives while the agent is answering their reports, the answer is no longer cut off and marked as an error. The message waits until the answer is done, then runs (DOR-2829)
