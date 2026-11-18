---
covers:
  - 'feat(tasks): an agent sets up a one-shot task with its own exact commands, and takes them back, with no card (DOR-4315)'
  - "fix(tasks): a one-shot task's commands ride only while its agent is still at Full, and a fire that never ran gives its turn back (DOR-4315)"
  - 'fix(tasks): a one-shot fire keeps its turn when it opened a run, however many old runs were pruned (DOR-4315)'
---

### Added

- An agent can set up a task that runs once, for a job like a backfill. It can give that one run a short list of exact commands to run without asking, with no approval card. Afterwards it takes the commands back, also with no card. Every change is recorded. (DOR-4315)

### Security

- Those commands must each be one exact line, with no wildcards or shell tricks, and no wider than what the agent itself may already do. DorkOS records each program when the list is set. If a program changes before the run, or the agent's own level drops below Full, the run stops and nothing runs. Adding commands later still takes a person's yes. (DOR-4315)
