---
covers:
  - "fix(server): a file you open on a chat's canvas saves, inside the agent's folder only (DOR-4442)"
---

### Fixed

- A file you open yourself on a chat's canvas can now be edited and saved, as long as it sits in that agent's folder. Before, every save said "This file can't be edited from this canvas." Files outside the agent's folder still can't be saved from there. If a file you opened earlier still won't save, open it again.
