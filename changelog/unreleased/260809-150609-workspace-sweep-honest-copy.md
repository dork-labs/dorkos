---
covers:
  - 'fix(workspace): sweep honors the retention cap; page and docs stop claiming automatic workspaces'
---

### Fixed

- The Workspaces page and docs no longer say DorkOS creates workspaces automatically. Today a
  workspace is created only when a tool or script asks the server for one. The empty state, the
  guide, and the glossary now say so plainly.
- Workspace retention cleanup now honors your `retentionCap` setting: it keeps your most recently
  used checkouts and skips any workspace a session is still using, instead of trying to remove
  every unpinned workspace. DorkOS does not yet run this cleanup on its own.
