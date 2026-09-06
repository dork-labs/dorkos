---
covers:
  - 'fix(connectors): verify raw MCP before connecting (DOR-738)'
  - 'fix(connectors): retain terminal flow replays (DOR-738)'
  - 'fix(connectors): pin active connection polls (DOR-738)'
  - 'fix(connectors): close connect flow races (DOR-738)'
  - 'fix(connectors): retain revoked ownership tombstones (DOR-738)'
---

### Fixed

- DorkOS now reaches a remote tool server and reads its tool list before it shows connected. Failed checks add no account and explain what to fix. Closing before a check starts keeps it closed. Simultaneous connections stay with the right provider. Repeated disconnects cannot bring back a removed server. (DOR-738)
