---
covers:
  - 'fix(client): a held space post sends its files once, not twice (DOR-2835)'
---

### Fixed

- When a space holds your message (you're muted, slow mode is on, or you haven't accepted the rules yet) and you send it again, its files are no longer uploaded a second time. The files you already uploaded go with it.
