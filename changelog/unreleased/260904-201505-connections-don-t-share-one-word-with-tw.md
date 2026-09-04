---
covers:
  - "fix(client): connections don't share one word with two meanings (DOR-1754)"
---

### Fixed

- The "Add a connection" dialog used "Connection" for both the thing you're picking and the thing you're creating. Picking a source now says "Source".
- Removing a connection now tells you plainly that nothing routes through it anymore, instead of reusing the same wording as removing a single routing rule.

### Changed

- The "Agent Discovery" tool group is now "Agent discovery", matching the other three groups.
