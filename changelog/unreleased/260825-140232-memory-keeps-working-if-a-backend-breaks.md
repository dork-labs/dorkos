---
covers:
  - 'feat(memory,shared,server,test-utils): the memory backend becomes swappable (DOR-1533)'
---

### Added

- Your agents keep their memory even if the thing storing it stops working. Memory now lives behind a swap point, so it can come from somewhere other than the notes file DorkOS ships with. If whatever you choose starts failing, DorkOS goes straight back to the notes file, mentions it once in the log, and your conversations carry on as normal — a memory problem can never end a chat (DOR-1533)
- A new setting, `memory.provider`, says where your agents keep what they remember. It starts as `builtin`: one small notes file beside each agent, on your machine, which you can open in any editor. Only you can change it, and a change takes effect the next time DorkOS starts (DOR-1533)
