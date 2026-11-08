---
covers:
  - 'fix(browser): the sign-in strip reads cookie hosts the way a browser does (DOR-3957)'
---

### Fixed

- Saved sign-ins drop DorkOS and DorkOS Cloud cookies however their address is written, like `127.1`, and cookies with no site named at all (DOR-3957).
