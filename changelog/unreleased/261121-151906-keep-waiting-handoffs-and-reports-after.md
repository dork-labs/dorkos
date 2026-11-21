---
covers:
  - 'fix(rooms): keep waiting handoffs and reports after restart (DOR-3816)'
---

### Fixed

- A hand-off waiting on a busy room seat, or a report waiting to come back from a spin-off chat, now survives a server restart. If one can’t safely pick up where it left off, you get a notice instead of silence.
