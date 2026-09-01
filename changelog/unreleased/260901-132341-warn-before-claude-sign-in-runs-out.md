---
covers:
  - 'feat(server,client): warn before the Claude login expires (DOR-1653)'
---

### Added

- DorkOS now tells you when your Claude sign-in is about to run out, three days before it does, on the Claude card in Settings. Signing in again takes a moment when you choose it, and used to cost you a failed turn when you didn't (DOR-1653)

### Fixed

- A Claude sign-in that had already run out no longer shows as "Ready". DorkOS was only checking that a sign-in was stored, not that it still worked, so a run-out sign-in looked fine until a turn failed with an authentication error. It now offers you the sign-in button instead (DOR-1653)
