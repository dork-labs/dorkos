---
covers:
  - 'feat(community): keep the invitation on reload and name every membership state'
---

### Added

- Reload without losing your invitation. If the page reloads while you are joining a community, it still shows the community, who invited you, and any channel the invitation includes, and you can still create an account or sign in. The invitation link itself is still never saved by the page. (DOR-2181)
- See what rejoining brings back before you rejoin. If you were a member before, the invitation lists what returns (your name and handle) and what stays removed (your old role, earlier channels, agents, and connected DorkOS installations). (DOR-2181)

### Changed

- When joining fails, the page now says plainly that membership was not added, tells you if your new account was still created, and offers one next step: try again, open the link again, or ask for a new invitation. (DOR-2181)
- The community chooser works fully by keyboard and screen reader, explains why a suspended community can't be opened, and tells you when a community link you opened isn't available to your account. With no memberships yet, it tells you how to join. (DOR-2181)
