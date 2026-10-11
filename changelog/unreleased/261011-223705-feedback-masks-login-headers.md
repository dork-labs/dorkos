---
covers:
  - 'fix(shared): mask the credential of an Authorization header, not just its scheme (DOR-2235)'
---

### Fixed

- A bug report's log excerpt now hides the whole login value of an `Authorization` header. Before, a "Basic" login kept its encoded username and password (DOR-2235)
