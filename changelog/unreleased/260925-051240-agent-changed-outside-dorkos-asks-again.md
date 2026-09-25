---
covers:
  - 'refactor(server): share the outside-change observer between permissions and what comes next (DOR-2337)'
  - "feat(server): an agent's runtime, model or effort changed outside DorkOS re-asks for the schedules that follow it (DOR-2337)"
---

### Added

- If an agent's runtime, model or effort is changed by editing its settings file instead of through DorkOS, the change is recorded in Activity as **Changed outside DorkOS**, with the old and new values. Every approved scheduled task that uses the agent's own setting then waits for you again, and its card shows what changed, for example **Agent's model: claude-sonnet-4 → claude-opus-4**. Changing the setting back doesn't restart the task; you approve it. Changes you make in DorkOS don't make anything wait (DOR-2337)
