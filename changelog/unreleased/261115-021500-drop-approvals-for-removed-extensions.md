---
covers:
  - 'fix(extensions): drop the approvals of extensions that are no longer installed, with an audit line (DOR-4305)'
---

### Fixed

- When an extension's folder is gone, DorkOS now forgets the approval you gave it on its own, and notes it in the audit log. If you install that extension again, DorkOS asks you again.
