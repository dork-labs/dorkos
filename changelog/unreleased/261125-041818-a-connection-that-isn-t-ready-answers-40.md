---
covers:
  - "fix(api): a connection that isn't ready answers 409 connection_not_ready, and a block an agent may ask past names request_permission (DOR-4979)"
---

### Fixed

- Using a connected app that is paused, signed out or waiting on its owner answers `409 connection_not_ready` again with a sentence that says where to fix it, instead of a `400` that blamed the request (DOR-4979)
- When an agent's permissions block an action a person can still allow, the refusal again tells the agent to ask with the `request_permission` tool (DOR-4979)
