---
covers:
  - "feat(settings): show this computer's own Claude sign-in as Main, with its color (DOR-2492)"
  - "fix(settings): line up Main's bars and mark it in use when no default is chosen (DOR-2492)"
  - "fix(settings): drop Main's row as soon as a save gives its folder a row (DOR-2492)"
  - 'fix(settings): mark Main in use whenever no registered account is the default (DOR-2492)'
---

### Added

- Choose a color for this computer's own Claude sign-in in Settings. With two or more Claude accounts, Settings → Runtimes → Claude Code now lists that sign-in as "Main (this computer's sign-in)" under your other accounts, with its usage and its color dot. Click the dot to pick a color. Main can't be removed there, because it isn't an account you added (DOR-2492)
