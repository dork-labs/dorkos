---
covers:
  - 'fix(server): validate Host on /api, gate admin restart, lock the data directory (DOR-532)'
---

### Security

- Close a hole where a web page you visit could drive your agents. A page can point its own domain at your own machine, which makes your browser treat it as if it came from DorkOS. DorkOS now answers only to the address you actually use, so that page gets turned away (DOR-532)
- Reach DorkOS by another name, like `dorkos.example.com` behind a proxy? Set `DORKOS_TRUSTED_HOSTS=dorkos.example.com` and it works again. Turning on login skips the check entirely, and the official Docker image is unchanged (DOR-532)

### Fixed

- Stop the Restart and Reset buttons from leaving the desktop app with no server. They now explain that quitting and reopening DorkOS is the way to restart (DOR-532)

### Added

- Refuse to start a second DorkOS against the same data directory, and say which one already has it. Two servers sharing one directory used to corrupt each other's agents and history (DOR-532)
