---
covers:
  - "feat(server,db,shared): a person can change when a package's schedule runs (DOR-2302)"
  - "feat(client): the Schedules page marks and resets a package schedule's own timing (DOR-2302)"
---

### Added

- You can now change when a schedule that came with an installed package runs. Edit it on the Schedules tab and pick a new time or timezone; DorkOS keeps your timing, so the package's files stay as they shipped and your choice survives its updates. The row says "Your timing", and "Reset to the package's default" puts the package's own timing back. If an agent changes when one of these schedules runs, it stops and waits for you to approve it again (DOR-2302)

### Fixed

- Saving an edited schedule now sends only what you changed. Before, every save sent every setting, so a schedule from an installed package could not be saved at all (DOR-2302)
