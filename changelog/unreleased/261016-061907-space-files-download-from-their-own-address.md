---
covers:
  - 'feat(community): files and exports download through signed links, from a separate address when one is set (DOR-2957 part 2)'
  - 'chore(community): tighten the user-content address checks, document download links, and say what a link allows (DOR-2957)'
---

### Changed

- In a space's web page, files and exports now download through a short-lived link. A link works for a few minutes (an hour for an export), and only while the person it was made for is still signed in and can still open the file (DOR-2957)
- If you run your own space server: set `COMMUNITY_USER_CONTENT_URL` to give downloads an address of their own, so a file never opens on the space's own address. Without it, downloads come from the space's own address, as before (DOR-2957)
