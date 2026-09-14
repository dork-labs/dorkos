---
covers:
  - 'fix(client): only say the server is unreachable when nothing answered (DOR-2035)'
  - 'fix(client): say what the server answered, and keep a host refusal readable (DOR-2035)'
---

### Fixed

- The "DorkOS can't reach its server" screen now only appears when nothing answers at all. When a request for your settings comes back with an error instead, DorkOS says that and shows the status code it got, rather than telling you the server is down (DOR-2035, #1841)
- When DorkOS will not answer to the address you reached it on, it now says so in words you can act on, instead of a bare error code (DOR-2035)
