---
covers:
  - 'fix(runtimes): several helpers finishing at once no longer end the chat in an error (DOR-2829)'
---

### Fixed

- When several of a Claude Code agent's helpers finish at the same moment, the chat no longer stops with an error. The agent's answer to their reports now finishes and shows once, and a message you send meanwhile waits until that answer is done (DOR-2829)
