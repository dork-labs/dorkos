---
covers:
  - 'refactor(server): require a TurnOrigin when a session is seeded (DOR-2105)'
  - 'refactor(server): a room seeds only a session row it mints (DOR-2105)'
---

### Changed

- Every part of DorkOS that can start an agent session now has to say what started it: you, a room, a schedule, a chat connection, or a connected service. That is what decides how much freedom the session begins with, so a new way to start a session cannot skip the question and quietly land on the wrong level. Nothing changes for sessions you already run (DOR-2105)
