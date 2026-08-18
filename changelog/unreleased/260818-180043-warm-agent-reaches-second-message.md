---
covers:
  - "test(server): show a session's second message misses the process the first one warmed (DOR-1309)"
  - "fix(server): a session's second message reaches the agent the first one warmed, not a second one (DOR-1309)"
---

### Fixed

- From the second message on, a chat now reaches the agent the first message warmed up — replies start faster, and DorkOS stops holding a spare agent open for every chat. (DOR-1309)
