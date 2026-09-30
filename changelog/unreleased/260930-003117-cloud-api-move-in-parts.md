---
covers:
  - 'feat(cloud-api): let a move upload go up in parts (DOR-2297)'
  - 'docs(cloud-api): say what a parted move upload refuses, and when parts are kept (DOR-2297)'
---

### Added

- The public DorkOS Cloud API package (`@dork-labs/cloud-api`) can now say that a community move's file may be uploaded in pieces. A large community can then move in without one huge upload, and a dropped connection only costs one piece. Older answers without it still work as before. (DOR-2297)
