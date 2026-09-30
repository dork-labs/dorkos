---
covers:
  - 'fix(cli): read storage buckets through the Fly API field that exists, and replay launcher calls against the real services (DOR-2584)'
  - "fix(cli): only treat Fly's exact not-found answer as a missing bucket, and harden the contract checker and replay (DOR-2584 review)"
---

### Fixed

- Setting up your own community with `dorkos community deploy` no longer stops right after it creates the file storage for uploads. Setup was checking on the new storage with a request Fly doesn't support, so the check always failed. It now uses the one Fly does, and it recognises when a storage bucket is already gone instead of treating that as an error (DOR-2584)
