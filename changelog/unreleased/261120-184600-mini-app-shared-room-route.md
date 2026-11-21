---
covers:
  - 'fix(extensions): an agent building a mini app in a shared room is told why its folder is read-only and how to publish instead (DOR-4851)'
  - 'fix(extensions): review fixes for the read-only mini apps route (DOR-4851)'
  - 'fix(marketplace): a turn that read outside words never spends a standing Allowed on a package (DOR-4851)'
---

### Fixed

- An agent building a mini app in a room with another person in it now says why it can't edit the app's folder, and publishes each version to your personal marketplace instead. You approve each version in DorkOS, with no Terminal copying.
- A package an agent just created in your personal marketplace can now be installed right away.
