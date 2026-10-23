---
covers:
  - "feat(spaces): members can see who is in a space, and a paired app can read a space's settings (DOR-3005)"
---

### Changed

- A space's server now lets every member list who is in the space, with names and roles. Only owners and admins also see when each person joined. Nothing in the app uses this yet (DOR-3005)
- A space's server now lets the DorkOS app you paired read the space's settings, its rules and who is in it. Invitations, mutes and every change still need the space's own web pages (DOR-3005)
