---
covers:
  - "fix(server): hash the full cwd for a non-agent session's Relay identity (DOR-514)"
---

### Fixed

- Two unrelated projects with the same folder name (like two different "project" directories) no longer share one internal messaging identity
