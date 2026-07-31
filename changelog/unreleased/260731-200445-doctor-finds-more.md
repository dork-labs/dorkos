---
covers:
  - 'feat(cli): dorkos doctor finds the problems that only show up while DorkOS is running (DOR-797)'
---

### Added

- `dorkos doctor` now finds the problems that used to only show up as strange behaviour later: a room whose saved conversation has gone missing from disk (the reason an agent sometimes answers as if it has never met you), agent messaging rules DorkOS could not read, saved chat integrations whose settings are unreadable, chat connections pointing at an agent or an integration that no longer exists, and the same agent id claimed by two different folders.
- Those checks need DorkOS to be running, so they live behind `dorkos doctor --deep`. If DorkOS is not running, it says so and skips them — that is not a problem with your setup.
- `dorkos doctor --json` prints the same results as plain JSON, so you can pipe them into another tool.
- `dorkos doctor` now also checks how many files your system lets DorkOS keep open at once. Too few, and DorkOS starts failing in ways that never mention files.

### Changed

- An unreadable chat integration now says out loud that any bot token inside it is still sitting in the file in plain text, rather than leaving the file looking protected when it is not.
