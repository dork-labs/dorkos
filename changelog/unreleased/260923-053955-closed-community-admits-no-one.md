---
covers:
  - 'fix(community): admit no one new while a community is closed'
  - 'fix(community): verify an invitation before saying a community is closed'
---

### Fixed

- A closed community no longer accepts new invitations or members. Setting a community's admission to Closed already cancelled the invitations that were out, but an owner or admin could still make a new one and someone could join through it. Now no one new can be invited or join until the owner switches admission back to Invite only, and people who are already members keep their access. In the community's settings, the invite panel says the community is closed instead of offering a button that would not work (DOR-2178).
