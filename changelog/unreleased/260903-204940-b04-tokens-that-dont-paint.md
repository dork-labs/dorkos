---
covers:
  - 'fix(client,obsidian-plugin): the token batch also paints inside Obsidian (DOR-1750)'
---

### Fixed

- Button icons, status colours and running-task colours in the Obsidian panel no longer
  disappear or jump size. The token sweep that fixed these on the web was compiled against a
  second, separate stylesheet for Obsidian that hadn't caught up (DOR-1750)
- An integration's "disconnected" dot and its "connecting" dot are amber again, not two
  different ambers side by side in the same list (DOR-1750)
