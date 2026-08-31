---
covers:
  - 'fix(desktop): raise the deep-link TTL to the boot budget, log on expiry (review)'
---

### Fixed

- A dorkos:// link opened during a slow first boot now still opens once the app is ready, instead of silently doing nothing
