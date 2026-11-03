---
covers:
  - "fix(security): a forged linked-worktree pointer can't make a folder resolve as another agent (DOR-3706)"
---

### Fixed

- DorkOS checks that a project copy really belongs to an agent's project before a chat there runs as that agent, and a chat's agent stays the same once it's set.
