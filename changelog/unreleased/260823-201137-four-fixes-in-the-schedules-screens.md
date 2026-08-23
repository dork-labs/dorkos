---
covers:
  - 'fix(client): four defects in the scheduled-tasks screens'
---

### Fixed

- Saving, deleting, or switching off a schedule no longer wipes the to-do list in an open chat. Any schedule change anywhere used to reset a working agent's checklist mid-answer.
- Run history stays accurate after you press "Load more". A run that finished while you were reading it used to keep spinning forever on the earlier pages.
- The on/off switch on a schedule moves back where it was when the change doesn't save, instead of claiming a schedule is off while it keeps running on its timer.
- A schedule whose cron expression DorkOS can't read can no longer be saved. The form already marked it in red; now Save waits until you fix it.
