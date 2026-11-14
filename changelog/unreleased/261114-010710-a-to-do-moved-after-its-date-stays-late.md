---
covers:
  - 'fix(server): a to-do moved after its date stays late in the on-time score (DOR-3034)'
---

### Fixed

- An agent's on-time score no longer forgives a late to-do. Moving a date before it's due still counts as agreeing a new date, but moving it after the date has passed keeps it late.
