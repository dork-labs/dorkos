---
covers:
  - 'fix(cli): let an interrupted setup resume when the create never happened (DOR-2701)'
---

### Fixed

- A space server setup you stop with Control-C just as it starts creating something can now carry on (DOR-2701). Before, the resume command it printed failed every time, and the setup stayed stuck. Now setup offers `dorkos community deploy --remove-uncertain <run-id>` instead. Once it shows the create never happened, it keeps what setup already made, such as your Fly app, and prints a resume command that works.
- When `--remove-uncertain` can't finish, it now lists everything that setup made, where each one is, and how to remove it, since those may cost money until you do.

### Added

- `dorkos community deploy --forget <run-id>` stops listing a stopped setup in `--list-incomplete` once you've removed what it made. It checks that each thing is really gone first, and changes nothing in your Fly or Neon accounts.
