---
covers:
  - 'feat(tasks): read schedule ownership from the installed-files record (DOR-2272)'
  - 'feat(tasks): offer Make my own copy when an edit to a package schedule is refused (DOR-2272)'
---

### Added

- You can now make schedules for an agent you installed from the marketplace, the same way as for any other agent, and they are kept when the package updates. Until now DorkOS turned every one of them down. Two cases are still refused, each with a note saying why: a name the package already uses for one of its own schedules, and any schedule for an agent whose package was installed by an older version of DorkOS (update or reinstall that package once and it works) (DOR-2272)
- When you try to change what a package's own schedule does, the edit window now explains why DorkOS won't change it and offers **Make my own copy**. It opens a new schedule for the same agent with your changes already filled in, ready for you to check and create. Before, the refusal only appeared as an error message with nothing to do next (DOR-2272)
