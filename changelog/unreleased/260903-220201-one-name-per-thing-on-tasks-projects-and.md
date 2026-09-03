---
covers:
  - 'fix(client): one name per thing on tasks, projects and runtimes (DOR-1754)'
---

### Changed

- Scheduled tasks are called tasks everywhere on the page now, and the run history says who started each run: a schedule, you, or an agent.
- The task form is clearer: "When it runs" instead of "Cron Expression", "Stop after" instead of "Max Runtime", and "Remember the last run" instead of "Sticky".
- Cross-project access says "project" throughout, instead of switching between project, namespace and directory.
- Settings → Runtimes now opens with a line saying what a runtime is, and the model and effort pickers say "Automatic" where they used to say "Runtime's choice".
