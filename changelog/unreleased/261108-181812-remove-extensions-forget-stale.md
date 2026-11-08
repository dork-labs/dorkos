---
covers:
  - 'wip(extensions): remove and forget routes (DOR-3541, DOR-3372)'
  - 'feat(extensions): remove an extension, and forget what a gone one was allowed (DOR-3541, DOR-3372)'
---

### Added

- Remove an extension from Settings → Extensions. Open its row and choose Remove: its folder and everything it was allowed are deleted, so nothing put back there later can reuse your old yes. Extensions that came with a plugin are removed by uninstalling the plugin. (DOR-3541)

### Fixed

- An extension whose folder is gone no longer keeps its approval out of sight. It shows under "Needs you" as "Folder missing", with Forget it to clear what it was allowed. (DOR-3372)
