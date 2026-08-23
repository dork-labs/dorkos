---
covers:
  - 'fix(client): four defects in the scheduled-tasks screens'
  - 'fix(client): close the schedule-toggle rollback race, and the review round with it'
---

### Fixed

- Saving, deleting, or switching off a schedule no longer wipes the to-do list in an open chat. Any schedule change anywhere used to reset a working agent's checklist mid-answer.
- Run history stays accurate after you press "Load more". A run that finished while you were reading it used to keep spinning forever on the earlier pages, and a run that started while you were reading could show up twice.
- Run history now says so when it can't be loaded, instead of showing "No runs yet" for a schedule with a long history.
- The on/off switch on a schedule goes back to what the server actually has when the change doesn't save, instead of claiming a schedule is off while it keeps running on its timer. It also stops accepting a second flip until the first one lands.
- Deleting a schedule clears its runs from the health dot in the top bar right away, rather than leaving a red count for runs that no longer exist.
- A schedule whose cron expression DorkOS can't read can no longer be saved. The form already marked it in red; now Save waits until you fix it.
