---
covers:
  - 'fix(notifications): a chat that errors before its id settles pings once, and not after it recovers (DOR-2136)'
---

### Fixed

- A chat that hit an error in its very first moments could send two "stopped on an error" phone pings, or one after it had already recovered. It now sends at most one, and none once the error clears.
