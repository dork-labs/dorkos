---
covers:
  - 'fix(client): the triage header says when it is holding more than it can show (DOR-1043)'
---

### Fixed

- The band above your home feed — the one holding approvals and anything that broke — only
  grows so tall before it starts scrolling inside itself. Until now it just cut the last
  card in half, which looked exactly like the end of the list, and on a Mac there is no
  scrollbar to say otherwise. Now the edge softly fades whenever there are more cards
  behind it, at the top and the bottom, and the fade goes away once you reach the end
  (DOR-1043)
