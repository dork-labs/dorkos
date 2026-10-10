---
covers:
  - 'fix(rooms): a thread counts its own first message when deciding who answers (DOR-2823)'
---

### Fixed

- When you start a thread by @mentioning an agent, your next messages in that thread now reach that agent without another @mention. Before, the thread's first message did not count, so a follow-up got no answer (DOR-2823)
