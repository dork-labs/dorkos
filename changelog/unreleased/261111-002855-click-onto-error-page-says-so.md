---
covers:
  - "fix(server): a browser click or key press that opens a page that won't load says so (DOR-3897)"
---

### Fixed

- When your agent clicks a link or presses Enter in the browser and the page it opens won't load, the agent is now told which site didn't load, instead of being told it worked. The action's record says it failed. Opening an address that won't load says so too (DOR-3897).
