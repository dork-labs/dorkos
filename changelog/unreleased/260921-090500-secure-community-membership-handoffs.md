---
covers:
  - 'feat(community): bind invitations to browser accounts'
  - 'fix(community): bind admission receipts to accounts'
  - 'fix(community): compose membership lifecycle behavior'
  - 'fix(community): settle repeated invitation admissions'
  - 'fix(community): finish membership protocol cleanup'
  - 'fix(community): let signed-out members review pairing'
---

### Changed

- Community invitation links now leave the address bar before the app begins loading, then continue through a short-lived browser approval. The link itself is never saved in browser storage or carried through sign-in, and switching accounts cannot take over another person's join attempt. Joining again after a lost response is safe, while leaving or being removed ends that approval for good. (DOR-2180)

- Leaving a Community now asks for your password and the Community name, then disconnects only that Community's installations, agents, channels, and live updates. Your account, browser sign-in, and memberships in other Communities stay in place. (DOR-2180)

### Fixed

- Opening a Community connection request while signed out now offers sign-in on the same page, then returns to the exact request for review. (DOR-2181)
