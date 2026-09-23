---
covers:
  - 'feat(community): give each community a short web address'
---

### Added

- A community on your Community server can now have a short web address, such as `your-host/acme`, instead of only its long ID link. Set it from the community's record on the host page. If you change it, the old address keeps working and takes people to the new one, and no other community can take it. A released address stays unavailable for 90 days by default, so a bookmarked link can't suddenly lead somewhere else (DOR-2256).
