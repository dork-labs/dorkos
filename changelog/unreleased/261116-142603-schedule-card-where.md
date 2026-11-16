---
covers:
  - "feat(schedules): the approval card says where a schedule's runs will happen (DOR-4067)"
  - 'fix(schedules): the run and the approval card share one folder chain (DOR-4067)'
  - "fix(schedules): the card says when an agent's private copy isn't made yet (DOR-4067)"
---

### Changed

- Before you approve a schedule, its card now says where it will run: the agent's folder and its path, a private copy of the agent's project, DorkOS's default folder, or a fresh private folder for each run. The card works this out with the same steps a run uses to pick its folder.
