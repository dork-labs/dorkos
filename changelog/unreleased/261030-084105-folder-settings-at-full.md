---
covers:
  - "fix(server): at Full, an agent home's settings load and log instead of asking (DOR-3432)"
---

### Fixed

- An agent set to Full autonomy no longer waits on a Needs you ticket because its folder already has settings. They now load, and one Activity line says so. This doesn't count as your approval: move the agent below Full and DorkOS holds those settings and asks you, as it always has at the lower levels.
