---
covers:
  - 'fix(server,relay): watchers report their own failures, and one cannot hang boot (DOR-830)'
---

### Fixed

- DorkOS watches files in the background so it can notice when your sessions, tasks, agent rules, and integration settings change on disk. When one of those watchers failed — usually because the machine ran out of file handles — it went quiet and nothing said so. Now each one writes a single clear line naming what it was watching and why it stopped. Repeats of the same failure are folded into that one line, and the line says so, so a quiet log afterwards is on purpose rather than a second thing to worry about. A watcher that stops does not restart itself: it keeps serving what it already loaded, but changes in that folder go unnoticed until you restart DorkOS.
- On a machine that had run out of file handles, DorkOS could get stuck partway through starting up and never finish — no window, no error, nothing in the log. It now starts, tells you which watcher failed, and runs with that one part degraded instead of not running at all.
