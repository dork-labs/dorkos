---
covers:
  - 'feat(agents): pause any agent everywhere at once, and anyone else can lift it (DOR-2738)'
---

### Added

- Anyone can now pause an agent everywhere at once, and anyone can lift the pause. Pausing stops what the agent is doing right now, including running scheduled tasks and work it left running in the background, and nothing starts it again until someone resumes it: your messages, its schedules, rooms, and messages from other agents or chat apps. Work it misses is not run later. Pause it from the **⋮** menu on its profile, with `dorkos agent pause`, or ask another agent. A paused agent can't resume itself, and every pause, resume and held-back piece of work is kept in the record (DOR-2738)
