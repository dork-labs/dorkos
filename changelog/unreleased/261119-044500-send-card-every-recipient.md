---
covers:
  - 'fix(approvals): a send’s approval card lists every recipient on its own line (DOR-4592)'
---

### Fixed

- When an agent asks to send an email or a calendar invite, the approval card now lists every recipient on its own line, above the other details. Before, a long list ended in "and 3 more", so an extra address could hide there. Hidden characters in an address show as a visible code, so one address can't pass for another.
