---
covers:
  - 'feat(marketplace): the schedules slot opens to every package type that can run one (DOR-1487)'
  - 'feat(server): declared package schedules become real files at install (DOR-1487)'
  - 'feat(marketplace,server): marketplace packages can ship scheduled tasks (DOR-1487)'
---

### Added

- Marketplace packages can ship scheduled tasks. Until now only a Shape could set one up; a plugin, agent template, or skill pack can now do it too, so a package that does recurring work brings its own schedule instead of leaving you to write one by hand after installing. (DOR-1487)
- A package sets up a schedule in one of two ways: it points at a skill it already ships, which puts the timing right in that skill's own file, or it describes the work itself, which creates a new skill for it. Either way you end up with a normal skill file you can read, edit, or delete. (DOR-1487)
- Before you install, the confirmation screen now lists the scheduled tasks any package will set up — not just a Shape's. It shows how often each one runs and what it is allowed to do while nobody is watching. (DOR-1487)
- Removing a package removes the scheduled tasks it created. Nothing it set up keeps running once it is gone, and skills you wrote yourself are never touched. (DOR-1487)

### Changed

- A package can never switch its own scheduled task on. Whatever the package asks for, the task waits for you to approve it before it runs for the first time, and a package cannot give itself permission to work unsupervised. (DOR-1487)
- A package will not overwrite a skill of yours. When one tries to create a scheduled task with the same name as a skill you already have, DorkOS keeps yours and tells you, rather than replacing it. (DOR-1487)

### Fixed

- Installing a package with a broken schedule now fails immediately, naming the package's schedule and what is wrong with it. It used to install fine and then turn up later as a task that could never run, with nothing to explain why. (DOR-1487)
