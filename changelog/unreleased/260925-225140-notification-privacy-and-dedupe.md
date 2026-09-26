---
covers:
  - 'fix(notifications): keep push addresses out of the log and stop duplicate alerts (DOR-2135, DOR-2140)'
---

### Fixed

- When a phone notification fails to send, the server log no longer records your phone's private push address. Logs are often attached to bug reports, so that address should never have been there (DOR-2135)
- The same notification raised twice at almost the same moment now reaches you once, instead of arriving twice in your inbox and in your chat app (DOR-2140)
