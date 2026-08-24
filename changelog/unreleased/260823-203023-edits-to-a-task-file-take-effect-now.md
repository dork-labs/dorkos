---
covers:
  - 'fix(server): an edit to a task file reaches the scheduler, not just the database'
  - 'fix(server): a cron that never comes round is a task you run by hand, not an error'
---

### Fixed

- Editing a scheduled task's file on disk now takes effect right away. Changing when a task runs used to update what the screen showed while the old schedule kept running, until you restarted DorkOS — and a task file you dropped in by hand got a card in the cockpit but never actually ran.
- A task whose file disappears now stops running, and starts again when the file comes back.
- A typo in a task's schedule can no longer stop DorkOS from starting. That one task sits out until you fix it, and everything else runs as normal.

### Changed

- Saving a task now checks the schedule before anything else, so a schedule DorkOS cannot read is refused on the spot with a message naming what is wrong — instead of being accepted and then quietly never running. That covers times it cannot read and timezones it does not know. A schedule that simply never comes round is still allowed — that is how you write a task you only ever run by hand.
