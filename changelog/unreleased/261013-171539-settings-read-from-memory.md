---
covers:
  - 'perf(server): read settings from memory until the file changes (DOR-2898)'
---

### Fixed

- DorkOS answers a little faster everywhere. It used to read and check your whole settings file from disk every time it looked up a setting, several times for every request. Now it keeps the last copy in memory and reads the file again only when it changed, including when you edit it by hand or with `dorkos config set` (DOR-2898)
