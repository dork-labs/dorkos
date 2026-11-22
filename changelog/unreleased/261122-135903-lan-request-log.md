---
covers:
  - 'fix(server): the server log records every request from another device on your network (DOR-5042, DOR-4736)'
  - 'fix(server): the server log records every request from another device, and never a secret (DOR-5042, DOR-4736)'
---

### Fixed

- The server log now records every request from another device on your network, with that device's address, whether DorkOS accepted it or not. The line never includes a sign-in token, a cookie or a video link's key (DOR-5042, DOR-4736).
