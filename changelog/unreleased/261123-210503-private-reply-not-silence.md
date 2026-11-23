---
covers:
  - 'fix(rooms): an agent that answers privately is no longer said to have not replied (DOR-4670)'
  - "fix(rooms): a first turn's private reply counts too, and a failed send never does (DOR-4670)"
---

### Fixed

- When you ask an agent something in a room and it answers by sending a private message instead, the room no longer says it "read this and did not reply". An agent that truly says nothing still gets that line (DOR-4670).
