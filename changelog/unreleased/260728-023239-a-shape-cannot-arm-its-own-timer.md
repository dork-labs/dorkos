---
covers:
  - 'fix(marketplace): a package can no longer arm its own unattended cron job (DOR-607)'
  - 'fix(marketplace): say so when a Shape still uses the retired startDisabled key (DOR-607)'
---

### Security

- The timers a Shape sets up can no longer start themselves, or hand themselves
  a free pass. A Shape's setup file lists recurring tasks it wants for you, and
  until now that list could say two things nobody had agreed to: start the moment
  this Shape is applied, and run with every approval prompt turned off. Both are
  the kind of thing you should decide, not the package. Now one of those timers
  arrives turned off unless the Shape's author asks for it to start, and a
  request to skip all approvals is refused: DorkOS sets the task up asking, and
  leaves you a note saying the Shape wanted more than it got. You can still turn
  the timer on, or raise what it may do, on the task itself once you have read
  what it does. This covers the timers a Shape asks for in its setup file; a
  package that ships a task file of its own is separate work, still to come
  (DOR-607)

### Fixed

- Scheduled tasks accept every permission mode DorkOS offers, not just two. Ask
  for "Plan", "Default", "Auto" or "Don't ask" and the task file DorkOS wrote was
  one it could no longer read: the task kept running, but the file on disk and
  the task in the app quietly disagreed from then on, and every edit to the file
  was ignored. All six modes now round-trip (DOR-607)
- Building a Shape? The setting that says whether one of its timers starts
  running is now called `startEnabled`, and it is off unless you turn it on. If
  your setup file still uses the old `startDisabled`, applying the Shape tells
  you so and points at the new name, instead of leaving you with a timer that
  never fires and nothing to explain it (DOR-607)
