---
covers:
  - 'fix(codex): name the folders Codex trusts in your settings once, and see a repo’s own Codex settings from any subfolder (DOR-4410)'
  - 'fix(server): the Codex trusted-folders startup step takes refs first, like every step (DOR-4410)'
---

### Fixed

- Older versions of DorkOS could let Codex mark a folder as trusted in your own Codex settings. DorkOS now lists, one time, every folder your Codex settings trust in Activity, so you can review them in Codex. It never changes that file.
- The Activity note that says a repo's own Codex settings loaded now also appears when you open a chat in a subfolder of that repo.
