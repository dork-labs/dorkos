---
covers:
  - 'fix(server): the session list re-reads the disk it stopped hearing from (DOR-577)'
  - 'test(server): pin that a discarded session-list watcher stops its sweep (DOR-577)'
---

### Fixed

- Fixed a bug where a Claude Code session started in a brand-new project — often one begun while DorkOS was still starting up — could be missing from your session list until you restarted the app. The list now re-checks your projects on disk every few seconds, so a session the file watcher failed to notice still turns up on its own (DOR-577)
