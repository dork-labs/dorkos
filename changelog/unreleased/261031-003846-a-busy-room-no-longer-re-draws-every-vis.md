---
covers:
  - 'fix(client): a busy room no longer re-draws every visible message on each scroll frame (DOR-3312)'
---

### Fixed

- A busy room or chat uses less CPU. Each new message used to redraw every message on screen many times while the view scrolled down to it. Now only the messages that changed are redrawn.
