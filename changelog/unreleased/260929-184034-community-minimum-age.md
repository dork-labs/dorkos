---
covers:
  - 'feat(community): let a host ask for a minimum age at sign-up (DOR-2554)'
  - 'feat(site): say who can buy a plan or a hosted community (DOR-2555)'
  - 'fix(community): use an age confirmation once, and word eligibility plainly (DOR-2554, DOR-2555)'
---

### Added

- The person running a Community server can set a minimum age with `COMMUNITY_MINIMUM_AGE`. Everyone who creates an account then sees "You must be at least N to join" and ticks a box to confirm it first, whether they sign up with a password, Google, GitHub, or single sign-on. The server checks too, so no account is made without the tick. Leave it unset and nothing changes (DOR-2554)

### Changed

- The pricing page and the Communities guide now say that paid plans, and communities DorkOS hosts for you, are for people in the United States who are 18 or older. The free, open-source app, and running DorkOS or a community yourself, stay open to everyone, wherever they live (DOR-2555)
