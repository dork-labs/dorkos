---
covers:
  - 'fix(session): a queued message keeps its limits through a pause and a restart (DOR-4350)'
---

### Fixed

- A message waiting in a chat's queue now keeps its limits when you pause the agent or DorkOS restarts. When it runs, it still says it came from outside your team, so any refusal names that, rather than showing a plain approval card.
