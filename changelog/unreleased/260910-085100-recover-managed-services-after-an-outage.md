---
covers:
  - 'fix(connections): recover managed services after hosted outage (DOR-1961)'
---

### Fixed

- Managed services now return when DorkOS can reach them again. A temporary outage during startup could hide them until you restarted or linked your account again.
