---
covers:
  - 'fix(client): only say the server is unreachable when nothing answered (DOR-2035)'
---

### Fixed

- The "DorkOS can't reach its server" screen now only appears when the server really is not answering. When the server is running but replies with an error, DorkOS says that instead and shows the error it got back, so you are not sent looking for a server that was never down (DOR-2035, #1841)
