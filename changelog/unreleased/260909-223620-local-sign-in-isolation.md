---
covers:
  - 'fix(auth): isolate local sign-in cookies by instance'
---

### Fixed

- Keep sign-ins separate when you run DorkOS with different data folders on different local ports. The default port keeps existing sessions. Other ports require one sign-in after this update. (DOR-1953)
