---
covers:
  - 'fix(server): read every agent identity from its registered home (DOR-2355)'
---

### Fixed

- An agent working in a git worktree of its own repo, or in a checkout it owns, now keeps its own name, personality, memory and Claude account. Before, it could pick up an out-of-date copy of its settings that the branch happened to carry, and the agent settings screen could edit that copy instead of the agent (DOR-2355).
- A folder inside a room's files can no longer be registered as an agent, so a settings file someone commits to a room never becomes an agent of its own (DOR-2355).
