---
covers:
  - '#2431'
  - "fix(cli): say a removed Tigris bucket's access key is still active, and how to delete it (DOR-2646)"
  - 'fix(cli): print the Tigris key steps on every path after cleanup, and keep the key out of retained (DOR-2646)'
  - 'fix(cli): show the Tigris key steps only once the bucket is proved gone (DOR-2646)'
---

### Fixed

- When `dorkos community deploy --remove-uncertain` removes a Tigris bucket, it no longer says the bucket's access key was removed. Fly deletes the bucket but leaves its access key working in Tigris, so DorkOS now tells you, and shows you how to delete it: in the Tigris console, or with the Tigris command-line tool (run `tigris login oauth` and choose "Sign in with Fly", then find the key named after the bucket, usually `<bucket>_access_key`, and delete it by its id, which starts with `tid_`) (DOR-2646)
