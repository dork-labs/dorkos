---
covers:
  - "feat(tasks): an agent moves its own running Bypass task to Don't ask with the exact commands it needs, with no card (DOR-4315)"
  - "fix(tasks): a move off Bypass that stops part-way says so, and its list is recorded as the agent's (DOR-4315)"
---

### Changed

- An agent can make its own task safer. A task that is on and runs every command without asking can move to Don't ask, with a short list of the exact commands it needs. That only takes power away, so it needs no approval card. The task keeps its schedule, and every change is recorded. (DOR-4315)

### Security

- DorkOS records each program on that list and checks it before every run, including runs started by hand. If a program changed, or the agent itself no longer runs commands without asking, the run stops and nothing runs. Adding commands to any other task still takes a person's yes. (DOR-4315)
