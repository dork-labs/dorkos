---
covers:
  - 'feat(tasks): a global package can mark a schedule project-only (DOR-3376)'
  - "test(tasks): a project's approval never carries over to new work in the shared file (DOR-3376)"
  - 'feat(tasks): only projects that use the package get a copy (DOR-3376)'
---

### Changed

- A package installed for all projects can now mark a scheduled task as one that only makes sense inside a project. Such a task no longer shows up as a global schedule, and DorkOS doesn't ask you to approve it there. Instead, each project that uses the package gets its own copy on its Schedules page, switched off. Turn it on for the projects that want it, and it runs in that project's folder. If a project stops using the package, a copy you once switched on stays as it is.
