---
covers:
  - 'fix(extensions): open extension dialogs from registerDialog (DOR-2576)'
  - 'fix(extensions): harden extension dialogs and registrations (DOR-2576)'
---

### Fixed

- A dialog added by an extension now opens when the extension asks for it, and goes away when you close it with Escape, a click outside or its own close button. Before, it never opened, and one that ignored its closed state stayed on screen for good (DOR-2576)
