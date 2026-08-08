---
covers:
  - 'fix(server): re-provision the opencode sidecar when its version drifts from the pin (DOR-1034)'
---

### Fixed

- DorkOS now updates its managed OpenCode helper when a new version ships, instead of
  quietly keeping the old one (DOR-1034)
