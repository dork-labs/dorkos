---
covers:
  - 'fix(client): LinkSafetyModal becomes a real, keyboard-trapping dialog (DOR-1749)'
---

### Fixed

- The "open this link?" dialog now works properly with a keyboard: Escape closes it, Tab stays inside it, and focus lands on it the moment it opens instead of staying stuck behind it.
