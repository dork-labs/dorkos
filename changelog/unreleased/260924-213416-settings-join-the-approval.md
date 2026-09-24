---
covers:
  - "fix(tasks): a schedule's name, runtime, model, effort, time limit and memory are part of its approval (DOR-2323)"
---

### Security

- An approved schedule now waits for you again when an agent changes its name, the runtime, model or effort it runs with, its time limit, or whether it remembers earlier runs. Before, an agent could switch an approved schedule to a different model, or let it run for hours longer, and it kept running. A change you make yourself stays approved. Schedules you already approved stay approved through this update, with the settings they run with now (DOR-2323)

### Added

- When a schedule waits for your approval again, the card lists what changed since you approved it, with the old and the new value side by side, for example "Model: claude-sonnet-4 → claude-opus-4" (DOR-2323)
