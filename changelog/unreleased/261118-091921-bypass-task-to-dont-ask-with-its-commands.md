---
covers:
  - "feat(tasks): an agent moves its own running Bypass task to Don't ask with the exact commands it needs, with no card (DOR-4315)"
---

### Changed

- An agent can make its own running task safer. A task set to run every command without asking can move to Don't ask with a short list of the exact commands it needs. That only takes power away, so it needs no approval card. The task keeps its schedule, and every change is recorded. (DOR-4315)

### Security

- DorkOS records each program on that list and checks it before every run, including runs started by hand. If a program changed, or the agent's own level dropped below Full, the run stops and nothing runs. Adding commands to any other task still takes a person's yes. (DOR-4315)
