---
covers:
  - 'fix(runtimes): a test server never reads the Mac Keychain (DOR-4423)'
---

### Fixed

- A DorkOS server started in test mode no longer reads your Mac's Keychain. Checks that need it
  report no information instead.
