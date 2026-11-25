---
covers:
  - "fix(api): the to-do and promise reads, adding a promise for an agent and the list of what can't wake are served by the capability mount (DOR-4978)"
  - 'fix(api): review round 1 on the to-do and heartbeat doors (DOR-4978)'
---

### Changed

- Reading to-dos and promises now follows an agent's To-dos permission. If you set To-dos to Blocked for an agent, it can no longer read them through the API either. An agent you turned off, or whose sign-in expired, can no longer read them at all. A caller whose agent key DorkOS doesn't recognize still reads them, as before, under your default To-dos setting. The list of schedules that can't run stays readable by anyone, as before. Adding a promise for an agent from a script now answers `person_only` when the script isn't you in the app.
