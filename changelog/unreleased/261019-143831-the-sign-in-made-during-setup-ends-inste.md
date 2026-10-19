---
covers:
  - 'fix: the sign-in made during setup ends instead of hiding, and setup always turns the password on (DOR-3097)'
---

### Fixed

- If `dorkos auth enable` can't end the sign-in it made while setting up, the password still turns on, and DorkOS ends that sign-in the next time it starts. A leftover one from an earlier setup is ended the same way, not hidden from Signed-in devices. (DOR-3097)
