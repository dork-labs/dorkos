---
covers:
  - 'fix(server): clamp bypassPermissions on the shape-schedule fallback path too (DOR-823)'
---

### Fixed

- Closed a rare edge case where a Shape-installed schedule could start with every approval prompt turned off instead of the normal, safer defaults
