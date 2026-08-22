---
covers:
  - 'feat(client): the home surfaces wear one bar — tabs in the header, filters in the page (DOR-1401)'
  - 'fix(client): the home bar stops blinking, its tabs become real targets, and the health dot holds still (DOR-1401)'
---

### Changed

- Home, Activity, Scheduled and Workspaces now switch from tabs inside the header itself, so each of those pages starts one row higher and shows more of what you came for (DOR-1401)
- Home lost the extra row that named your #team room. The Home tab says which page you are on, the box at the bottom says which room you are writing to, and the header now shows how many people and agents are in it — press that head count to open members (DOR-1401)
- Activity's category filters moved out of the header and onto the page, above the feed they filter (DOR-1401)
- The little system-health dot sits at the same spot on all four of those pages now, so it never moves as you switch between them (DOR-1401)
- Workspaces no longer prints its own title under the header that already says it (DOR-1401)
