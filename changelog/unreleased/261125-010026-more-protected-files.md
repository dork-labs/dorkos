---
covers:
  - "fix(security): the hub's signing key is a protected file (DOR-5241)"
---

### Fixed

- Agents can't open a few more of DorkOS's own key files with their file tools, at any trust level: a hub's signing key, the remote-chat link files, the one-time setup code and the page stamp key (DOR-5241).
