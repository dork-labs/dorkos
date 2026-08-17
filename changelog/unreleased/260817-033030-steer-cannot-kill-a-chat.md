---
covers:
  - 'fix(server): a steer answered late closes the right window, and a stranded window cannot wedge the session (DOR-1294)'
---

### Fixed

- If you turn on the experimental setting that keeps an agent warm between messages (`runtimes.claudeCode.persistentSession`, off by default), sending a message into a reply that was already being written could leave that chat stuck — every message afterwards went nowhere, and only restarting DorkOS brought it back. It no longer can: a late answer is matched to the message it belongs to, and a reply that never finishes is closed out so the next message still runs. When that happens the unfinished reply is marked as an error rather than left spinning, and your next message goes through normally (DOR-1294).
