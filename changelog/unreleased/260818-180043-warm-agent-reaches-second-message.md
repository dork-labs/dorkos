---
covers:
  - "test(server): show a session's second message misses the process the first one warmed (DOR-1309)"
  - "fix(server): a session's second message reaches the agent the first one warmed, not a second one (DOR-1309)"
  - "test(server): pin the pump's remaining id-resolution seams, and correct the rekey ADR and changelog (DOR-1309)"
---

### Fixed

- With **Keep agents warm between messages** turned on (Settings → Experiments), a chat now reaches the agent the first message warmed up from the second message on, instead of starting a second one beside it. Replies start faster, and DorkOS stops holding a spare agent open for every chat. (DOR-1309)
