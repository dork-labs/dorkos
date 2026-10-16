---
covers:
  - 'feat(community): space pages run only their own code, and every route sends pinned security headers (DOR-2957 part 1)'
  - 'chore(community): give the page policy only to the space page, pin it on live streams, and clear a link secret before the page loads (DOR-2957)'
---

### Changed

- Space pages are harder to attack. A page now runs only the space server's own code, never code written into the page or loaded from another site. No other site can show a space page inside its own. A file opened straight from a space can't run anything (DOR-2957)
