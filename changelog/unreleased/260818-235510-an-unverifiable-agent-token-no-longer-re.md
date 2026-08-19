---
covers:
  - "fix(server): an unverifiable agent token no longer reads where a room's work runs (DOR-1357)"
---

### Security

- A program calling DorkOS with an agent token DorkOS cannot verify can no longer see which session each agent in a channel is working in. Only a person can (DOR-1357)
