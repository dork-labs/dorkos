---
covers:
  - "fix(rooms): record a room session's program before its first turn starts (DOR-2447)"
---

### Fixed

- A Codex agent's first message in a room no longer fails with "Canonical runtime authority could not be verified". DorkOS now records which program a room conversation runs on as its first turn starts, so the agent's connections open on the first try (DOR-2447).
