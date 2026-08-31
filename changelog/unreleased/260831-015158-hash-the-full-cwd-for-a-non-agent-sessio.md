---
covers:
  - "fix(server): hash the full cwd for a non-agent session's Relay identity (DOR-514)"
  - 'fix(server): keep the session-origin label legible after the DOR-514 hash fix'
---

### Fixed

- Two unrelated projects with the same folder name no longer share one internal messaging identity, and a session's origin still shows its project name
