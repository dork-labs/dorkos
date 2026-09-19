---
covers:
  - 'refactor(server): require a TurnOrigin when a session is seeded (DOR-2105)'
---

### Changed

- Every part of DorkOS that can start an agent session now has to say what started it: you, a room, a schedule, a chat connection, or a connected service. That is what decides how much freedom the session begins with. A new way to start a session can no longer skip the question and quietly land on the wrong level. Sessions you start today behave exactly as before (DOR-2105)
