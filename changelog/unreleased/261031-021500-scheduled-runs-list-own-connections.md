---
covers:
  - 'fix(server): a scheduled run can list its own connected accounts with nobody there (DOR-3205)'
---

### Fixed

- A scheduled run can now see which connected accounts it was given, and what each one lets it do, without a person there to approve. Before, it was refused and couldn't find out which account to use. Using those accounts still needs approval as before, and a turn started by someone outside your team still can't list them.
