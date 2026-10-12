---
covers:
  - 'fix(server): a connection added while settings reload is never dropped'
---

### Fixed

- A connection you just added no longer vanishes for a moment if DorkOS reloads its connection settings at the same time. Removing or editing it right away used to say it could not be found
- Removing a connection can no longer remove a different one when the connection settings reload at the same moment
