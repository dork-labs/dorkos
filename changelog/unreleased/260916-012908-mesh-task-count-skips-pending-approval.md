---
covers:
  - 'fix(server): a schedule waiting for approval no longer counts as an agent live task (DOR-2087)'
---

### Fixed

- An agent's task count in the mesh view no longer includes a schedule that is still waiting for your approval. Before, a newly proposed schedule made the agent look like it was already running work it had not started yet (DOR-2087)
