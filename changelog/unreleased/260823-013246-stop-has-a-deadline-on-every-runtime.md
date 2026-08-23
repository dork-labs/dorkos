---
covers:
  - 'fix(server): stopping an agent now has a deadline on OpenCode too (DOR-1299)'
  - 'fix(server): review follow-ups on the OpenCode Stop bound (DOR-1299)'
---

### Fixed

- Pressing Stop while OpenCode is stuck no longer strands the messages you had queued up.
  Before this fix, if OpenCode didn't answer a Stop request, your typed-but-unsent messages
  could stay stuck until OpenCode finished on its own, sometimes indefinitely. Now DorkOS
  waits about 3 seconds for OpenCode to respond, then gives up and returns your messages to
  the message box so you can send them again (DOR-1299).
