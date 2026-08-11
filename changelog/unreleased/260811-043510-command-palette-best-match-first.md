---
covers:
  - 'feat(client): ⌘K answers with one ranked list, best match first (P3.2, DOR-1074)'
  - 'fix(client): ⌘K withholds "Best match" when nothing was typed, and its constants say what they control (P3.2 review, DOR-1074)'
---

### Changed

- ⌘K now puts the best match first. Typing gives you one list, ordered by how well each thing
  matches what you typed, how much you use it, and how fresh it is — so a channel called
  `#shipping` comes before an agent that only nearly matches, instead of always sitting below it.
  When one row is clearly the one you meant, it gets its own "Best match" line on top (DOR-1074).
