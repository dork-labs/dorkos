---
covers:
  - 'feat(shared): add open admission, bans and auto-join to the Community wire (DOR-2764)'
  - 'feat(community): open admission, auto-join channels and bans (DOR-2764)'
  - 'feat(community): ban and unban in the space, and its open join page (DOR-2764)'
---

### Added

- A space can now be open to anyone who signs in with the server's single sign-on. They join with one click on the space's own page, with no invitation. It never allows a password sign-up, and the person running the server can turn open joining off for everyone at once (DOR-2764)
- Owners and admins can mark channels that every new member joins when they arrive (DOR-2764)
- Owners and admins can ban someone from a space. A ban removes them and keeps them from coming back with that account or that email address, and it can be lifted later. Admins can ban members, but only the owner can ban an admin (DOR-2764)
