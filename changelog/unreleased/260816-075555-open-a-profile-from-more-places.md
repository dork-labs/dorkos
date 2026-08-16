---
covers:
  - 'feat(client): view a profile from member lists, message faces and the presence strip (DOR-1251)'
  - 'fix(client): profile entry points open the roster''s id, and your own face says "your" (DOR-1251)'
  - 'fix(client): profile faces stay out of the tab order; room sheet rows scroll and slide as before (DOR-1251)'
---

### Added

- Open somebody's profile from three more places in a room: the face beside any message, the face and name of anyone in the members list, and the card that pops up when you point at an agent on the "working right now" strip. Each one opens the same profile you already get from your team page or a mention (DOR-1251)
- A message's own actions — the row you get on hover, right-click, or a long press — now include "View profile", so you can get there without leaving the keyboard (DOR-1251)

### Fixed

- The "working right now" strip's pop-up card offered "View profile · soon". It opens the profile now (DOR-1251)
- Your own face and your own row in a members list now say "Open your profile" instead of "Open You's profile" (DOR-1251)
