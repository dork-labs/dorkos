---
covers:
  - 'fix(server): a helper you stopped says it was stopped (DOR-1146)'
---

### Fixed

- Stop an OpenCode agent while a helper agent is working for it, and the helper's
  card now says it was stopped. It used to end with a shrug: DorkOS marked it as
  something it had lost track of, even though you were the one who stopped it.
