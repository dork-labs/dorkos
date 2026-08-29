---
covers:
  - 'feat(desktop): offer to move DorkOS into Applications when it runs from the wrong home'
---

### Added

- If you launch DorkOS from the window that opens when you double-click the download, it now offers to move itself into your Applications folder, so updates keep working. An app run from that window can't update itself, which is the difference between getting new versions and quietly never getting one again. DorkOS asks once, takes no for an answer, and doesn't ask again unless you move it somewhere else. Mac only. (DOR-1495)

### Changed

- The Mac install steps now tell you to open DorkOS from your Applications folder rather than from the window the download opened, and say why it matters. (DOR-1495)
