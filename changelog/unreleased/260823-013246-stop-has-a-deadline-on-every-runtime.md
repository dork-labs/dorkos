---
covers:
  - 'fix(server): a stuck OpenCode Stop no longer strands your queued messages (DOR-1299)'
---

### Fixed

- Pressing Stop while OpenCode is stuck no longer strands the messages you had queued up.
  Before this fix, if OpenCode didn't answer a Stop request, your typed-but-unsent messages
  could stay stuck until OpenCode finished on its own, sometimes indefinitely. Now DorkOS
  waits about 3 seconds for OpenCode to respond, then gives up and returns your messages to
  the message box so you can send them again (DOR-1299).
