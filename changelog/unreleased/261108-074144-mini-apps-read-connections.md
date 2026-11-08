---
covers:
  - 'feat(extensions): a mini app can declare the apps it reads, and a change to that list waits for a person (DOR-3547)'
---

### Added

- Let a mini app that runs in its own sandbox read from an app you connected, after you approve it once: it never sees a password or token, it can only read, and every read shows under its name (DOR-3547)
