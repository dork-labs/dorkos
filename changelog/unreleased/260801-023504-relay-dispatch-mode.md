---
covers:
  - "fix(relay): a scheduled run's permission mode is checked, not just carried"
---

### Fixed

- A scheduled task whose permission mode was somehow set to a value no agent recognizes is now rejected when the run is dispatched, with the reason recorded, instead of starting a session in an unknown safety mode.
