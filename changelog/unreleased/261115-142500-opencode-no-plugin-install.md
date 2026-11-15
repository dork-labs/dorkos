---
covers:
  - 'fix(opencode): OpenCode chats start without installing a package first'
---

### Fixed

- OpenCode chats in a new folder start right away again, instead of waiting while OpenCode downloads a package (up to about a minute offline). OpenCode commands don't get `DORKOS_SESSION_ID` for now.
