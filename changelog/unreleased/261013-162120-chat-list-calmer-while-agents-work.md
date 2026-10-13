---
covers:
  - 'perf(server): a working agent no longer keeps the chat list busy (DOR-2893)'
---

### Fixed

- The app stays quick while your agents work. Each time an agent wrote to a chat, DorkOS re-read that project's chats and rebuilt your Recent list from scratch, over and over. Now a chat that is being written to updates its row every few seconds, and the Recent list is rebuilt only when a chat is added or removed. A chat that an agent writes to without pausing now keeps its row up to date, instead of freezing until the agent stops (DOR-2893)
