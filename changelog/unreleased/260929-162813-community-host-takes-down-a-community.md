---
covers:
  - 'feat(community): let a host take down a whole community, keep a copy for the authorities, and undo it for a few days (DOR-2293)'
  - "fix(community): count a host's daily takedowns under a lock, copy only whole evidence archives, and keep only the accounts the evidence needs (DOR-2293)"
  - 'fix(community): read only owner manifests on the version 2 import path (DOR-2293)'
---

### Added

- A person who runs a Community server can now take down a whole community when they learn it is illegal. It closes at once: every member sees "This community was removed by its host.", every connected DorkOS app and agent loses access, and any finished export is deleted. If the host has a separate evidence store, the server first saves a full copy of the community there, with each member's account details, because many laws require keeping one for the authorities. The owner is told why, unless the host holds that back, and can't cancel it. The community is deleted after three days by default. Until then the host can undo it, and the community comes back paused rather than open. One person or key can remove at most three communities a day, so a leaked key can't quietly remove many (DOR-2293)
- A Community server now tells connected DorkOS apps plainly when its host took a community down, as a different answer from a pause or an ordinary deletion (DOR-2293)
