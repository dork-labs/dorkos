---
covers:
  - '#3557'
---

### Added

- **Leave one agent out when you share an app with every agent.** That agent keeps only the access you gave it by name. Apps you share with every agent later don't reach it either, and you can let it back in at any time. Only a person can do this, not an agent. For now it's done through the DorkOS API (`/api/connectors/connections/{id}/exclusions`); the Connections page doesn't show it yet.
