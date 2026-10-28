---
covers:
  - 'feat(spaces): owners and admins can let the app manage a space, with their consent (DOR-3005)'
  - 'fix(spaces): the app does not ask to manage a space yet, and the hard moves stay in the browser (DOR-3005)'
---

### Added

- Spaces can now let an owner's or admin's own DorkOS app manage them, but only after that person types their password. The DorkOS app doesn't ask for this yet, so nothing changes for anyone today (DOR-3005)
- Making someone an admin, removing a member, and changing who may join a space always happen in the browser, never through an app (DOR-3005)
