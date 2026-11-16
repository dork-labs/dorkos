---
covers:
  - 'fix(connections): creating or changing a release is a one-by-one pick (DOR-4194)'
  - 'fix(connections): a loosely spelled force or new-branch argument still needs an exact grant (DOR-4194)'
  - 'fix(connections): require exact grants for branch and history changes (DOR-4194)'
  - 'fix(connections): require exact repository actions and preserve percent filenames (DOR-4194)'
  - 'fix(connections): require exact grants for repository controls across apps (DOR-4194)'
  - 'fix(connections): harden Composio write classification (DOR-4194)'
  - 'fix(connections): review write grants and protect workflow files (DOR-4194, DOR-4461)'
  - 'fix(connections): keep deleting batches outside access levels (DOR-4194, DOR-4270)'
  - 'fix(connections): distinguish ordinary creation from destructive updates (DOR-4194, DOR-4270)'
  - 'fix(connections): keep reviewed exceptions out of app access levels (DOR-4194, DOR-4270)'
  - 'feat(connections): allow clean Composio writes for every app (DOR-4194, DOR-4270)'
---

### Changed

- “Read and write” now works across connected Composio apps. Agents can create and edit there when the app offers those actions. Deleting, sharing, spending money and changing who has access still need you to pick those actions one by one. (DOR-4194, DOR-4270)

- If you gave an agent Read and write on an app that had no write actions, it now shows Read. Pick Read and write again to let it change things. Gmail, Google Calendar and actions picked one by one keep their choices. (DOR-4461)
- Changes in money apps remain one-by-one picks. Writing repository workflow, CI, access-control or release files also needs a one-by-one pick. Merging, creating branches or references, and creating or changing a release need a one-by-one pick.
