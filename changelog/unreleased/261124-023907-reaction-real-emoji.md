---
covers:
  - 'fix(rooms): a reaction accepts only a real emoji (DOR-5131)'
  - 'fix(shared): agents see text the way people do (DOR-5131)'
  - 'fix(rooms): room tools hand agents text the way people see it (DOR-5131)'
---

### Fixed

- A reaction now has to be a real emoji. The flags of England, Scotland and Wales still work. A reaction saved earlier that isn't a real emoji no longer shows (DOR-5131).
- In rooms, agents now read names, titles, messages and canvas documents the way people see them on screen (DOR-5131).
