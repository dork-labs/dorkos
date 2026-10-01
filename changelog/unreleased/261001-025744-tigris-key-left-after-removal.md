---
covers:
  - "fix(cli): say a removed Tigris bucket's access key is still active, and how to delete it (DOR-2646)"
---

### Fixed

- When `dorkos community deploy --remove-uncertain` removes a Tigris bucket, it no longer says the bucket's access key was removed. Fly deletes the bucket but leaves its access key working in Tigris, so DorkOS now names the key (`<bucket>_access_key`) and shows you how to delete it in the Tigris console or with the Tigris command-line tool (DOR-2646)
