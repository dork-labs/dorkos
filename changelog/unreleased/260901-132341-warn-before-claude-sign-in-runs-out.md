---
covers:
  - 'feat(server,client): warn before the Claude login expires (DOR-1653)'
  - 'fix(server,client): address adversarial review of the sign-in expiry warning (DOR-1653)'
---

### Added

- DorkOS now tells you when your Claude sign-in is about to run out, three days before it does, on the Claude card in Settings. It keeps saying so through the last few hours, when signing in again is most urgent. Doing it when you choose takes a moment; being caught out used to cost you a failed turn (DOR-1653)
- If you work through an API key instead, DorkOS stays quiet. It only mentions a sign-in that is actually doing your work, so a stored login you no longer use never nags you (DOR-1653)

### Fixed

- A Claude sign-in that had already run out no longer shows as "Ready". DorkOS was only checking that a sign-in was stored, not that it still worked, so a run-out sign-in looked fine until a turn failed with an authentication error. It now offers you the sign-in button instead (DOR-1653)
