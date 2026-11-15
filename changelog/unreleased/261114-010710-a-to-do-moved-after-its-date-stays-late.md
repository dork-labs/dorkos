---
covers:
  - 'fix(server): a to-do moved after its date stays late in the on-time score (DOR-3034)'
  - 'feat(todos): a moved to-do says so, and a dropped one counts in the on-time score (DOR-3034)'
  - 'fix(server): a later move or a cleared date cannot wipe a missed to-do from the score (DOR-3034)'
---

### Fixed

- An agent's on-time score no longer forgives a late to-do. Moving a date before it's due still counts as agreeing a new date, but moving it after the date has passed keeps it late.
- Dropping a to-do no longer takes it out of the agent's on-time score. It counts as one not kept on time.

### Changed

- A to-do whose date moved now says so under its title, with its first date, like "Moved twice, first due Mar 14".
