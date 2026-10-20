---
covers:
  - 'fix(team): the Team map draws agents with the open mesh on (DOR-3154)'
  - 'fix(team): the map says when everyone can message everyone, and never draws blank (DOR-3154)'
---

### Fixed

- The Team map shows your agents again. With "Let all my agents talk to each other" on, which is the default on Trusted, the map showed only its key and no agents. (DOR-3154)
- When everyone can message everyone, the Team map now says so in one line. If the map can't be drawn, it says so and offers Retry instead of showing an empty space. (DOR-3154)
