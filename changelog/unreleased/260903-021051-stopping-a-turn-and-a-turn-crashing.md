---
covers:
  - 'fix(server,client,shared): tell a stop you asked for from an abort you did not (DOR-1681)'
---

### Fixed

- Stopping a turn and a turn crashing no longer look the same. When a turn was cut short, DorkOS said you stopped it, whether or not you had touched Stop. So if the agent hit a refusal from the service and gave up on its own, the session was filed as one you ended on purpose and the message explaining what went wrong was wiped off the screen. That is the one thing you can check against your own memory, and it was wrong. Now the runtime says whether anyone actually asked it to stop, and that answer travels with the turn, so the live session and a page you reload after the fact agree. A turn nobody stopped that ended with a real error is marked as an error and keeps its explanation. A turn you stopped still shows as stopped, with no red mark and no scary text. Scheduled runs get the same fix: one that aborted on its own is now filed as failed with the reason, instead of quietly as cancelled (DOR-1681)
