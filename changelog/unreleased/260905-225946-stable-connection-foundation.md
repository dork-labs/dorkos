---
covers:
  - 'feat(connectors): add stable connection foundation'
---

### Changed

- Keep each connected account under its own DorkOS identity, preserve existing agent and session access during the upgrade, and show a clear recovery error if that upgrade cannot finish. Removing one connection from an agent now stops its live tools and revokes that connection’s grants, session access, and event delivery before the action completes. (DOR-1793)
