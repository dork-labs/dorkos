---
covers:
  - 'feat(community): give each community a short web address'
  - 'fix(community): address review of short web addresses (DOR-2256)'
  - 'fix(community): keep /setup from being taken as a short web address (DOR-2256)'
---

### Added

- A community on your Community server can now have a short web address, such as `your-host/acme`, instead of only its long ID link. Set it from the community's record on the host page. If you change it, the old address keeps working and takes people to the new one, and no other community can take it. A released address stays unavailable for 90 days by default, so a bookmarked link can't suddenly lead somewhere else (DOR-2256).
- Members can copy their community's address from its settings; it uses the short address when the community has one.
- If your Community server runs behind a proxy, set `COMMUNITY_TRUSTED_PROXY_HEADER` to the header your proxy puts each visitor's address in, such as `Fly-Client-IP`. Sign-up, invitation, pairing, and address-lookup limits then count each visitor on their own instead of everyone together (DOR-2256).
