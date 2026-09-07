---
covers:
  - 'fix(harness): a skill you named with `__` survives the apply that projected it (DOR-1844)'
---

### Fixed

- DorkOS only tidies away the skill shortcuts it made itself. A skill of your own with a double underscore in its name — `my__helper` — looked like one of those, so a sync could remove the shortcut it had just created for it (DOR-1844)
