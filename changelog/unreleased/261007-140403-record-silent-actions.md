---
covers:
  - 'feat(audit): record approved tool calls, setting changes, installs and sign-ins (DOR-2738)'
---

### Added

- The record now also holds actions that used to leave no trace: DorkOS tools an agent ran after you approved them, every setting change with its old and new value, packages installed, updated or removed, work merged into a room (and who merged it), API keys created or revoked, sign-ins, and updates that failed. Any other change made through the app or its API is recorded too: who did it, what kind of change, and whether it worked. Lines about sign-ins note where they came from, and are marked as the owner's alone (DOR-2738)
