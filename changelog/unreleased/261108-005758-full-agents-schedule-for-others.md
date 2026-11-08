---
covers:
  - 'feat(tasks): a chat at Full autonomy can schedule tasks for any agent (DOR-3938)'
  - "fix(tasks): only an outsider's mark refuses a cross-agent task write, and Full prompt edits stay live (DOR-3938)"
  - "fix(tasks): a cross-agent task's runs carry every writer's marks, capped on the edited runtime (DOR-3938)"
---

### Added

- An agent whose chat runs at Full autonomy can now schedule and change tasks for any of your agents, not only for itself. The task never runs above that agent's own level, the Activity log says who made it and for whom, and a chat that read messages from outside your team can't do it. (DOR-3938)
