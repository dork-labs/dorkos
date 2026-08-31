---
covers:
  - 'fix(server,client,shared): stop message search highlights from colliding with a literal "<mark>" in chat (DOR-1552)'
---

### Fixed

- Message search no longer confuses a literal "<mark>" someone typed into a message with its own highlight markers. A message containing that exact text now shows correctly, right next to a real match (DOR-1552)
