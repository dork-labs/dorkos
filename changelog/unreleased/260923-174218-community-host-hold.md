---
covers:
  - 'feat(community): let a host hold a community and delete it only after a published notice'
  - 'fix(community): keep a host deletion notice honest through suspension, and name who deleted'
---

### Added

- If you run a Community server, you can now put a community **on hold** instead of suspending it. Members can still read everything and the owner can still download an export, but no one can post, join, or change settings. Every channel shows a banner that says so. Releasing the hold puts the community back as it was (DOR-2255).
- A host can publish a deletion notice for a held community, at least two weeks away by default and never less than one. Members see the date on every channel. After it passes, the host can schedule the community's deletion, which waits the usual seven days and which only the host can cancel. An owner can still delete their own community during a hold, and cancelling that returns it to the hold (DOR-2255).
