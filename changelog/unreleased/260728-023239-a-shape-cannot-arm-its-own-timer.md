---
covers:
  - 'fix(marketplace): a package can no longer arm its own unattended cron job (DOR-607)'
---

### Security

- A Shape you install can no longer start its own timer running, or give that
  timer a free pass. Shapes can set up recurring tasks for you, and until now a
  Shape could say two things about one of them that nobody had agreed to: start
  the moment I am applied, and run with every approval prompt turned off. Both
  are the kind of thing you should decide, not the package. Now a timer arrives
  turned off unless the Shape's author asks for it to start, and a request to
  skip all approvals is refused: DorkOS sets the task up asking, and leaves you a
  note saying the Shape wanted more than it got. You can still turn the timer on,
  or raise what it may do, on the task itself once you have read what it does
  (DOR-607)

### Fixed

- Scheduled tasks accept every permission mode DorkOS offers, not just two. Ask
  for "Plan", "Default", "Auto" or "Don't ask" and the task file DorkOS wrote was
  one it could no longer read: the task kept running, but the file on disk and
  the task in the app quietly disagreed from then on, and every edit to the file
  was ignored. All six modes now round-trip (DOR-607)
