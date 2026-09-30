---
covers:
  - 'fix(communities): plain messages when connecting a community fails for a known reason (DOR-2568)'
---

### Fixed

- Connecting a community now tells you what actually went wrong instead of always saying to check the address. If no community uses that short address, it says so. If the community's host is busy, it tells you to wait, and for how long when the host says. If the community's server is too old, it tells you to ask whoever runs it to update it.
