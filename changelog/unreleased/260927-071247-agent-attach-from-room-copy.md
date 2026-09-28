---
covers:
  - "fix(rooms): let an agent attach a file from its own copy of a room's files (DOR-2410)"
  - "fix(rooms): attach only from the posting room's own copy, found by its exact name (DOR-2410)"
  - "fix(rooms): finish git's housekeeping before a room's git command returns (DOR-2410)"
---

### Fixed

- An agent in a room with files can attach a screenshot or recording it made in its own copy of the room's files again. Since room turns moved to the agent's own folder, those files were refused. Files in the room's shared folder or in another agent's copy still can't be attached (DOR-2410).
