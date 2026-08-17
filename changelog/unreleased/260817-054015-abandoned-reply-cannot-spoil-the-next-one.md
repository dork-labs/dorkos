---
covers:
  - 'fix(server): a stranded turn settles before its successor opens, so an abandoned turn cannot poison the next one (DOR-1295)'
---

### Fixed

- If you turn on the experimental setting that keeps an agent warm between messages (`runtimes.claudeCode.persistentSession`, off by default), a reply that never finished used to spoil the next one: DorkOS closed out the unfinished reply while your new message was already under way, so the new reply was marked failed and stopped mid-sentence even though the agent was still writing, and the chat's saved history mixed the two together. The unfinished reply is now closed out first, before the new one starts, so it is marked as an error on its own and your next message runs clean. The same goes for `/compact` after a reply that never finished (DOR-1295).
