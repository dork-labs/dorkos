---
covers:
  - "fix(rooms): show why a room's files are refused when its git settings name a program (DOR-2414)"
  - 'fix(harness): stop saying automatic skill moves happen in room folders (DOR-2414)'
---

### Fixed

- When a room's git settings could make git run a program, the room's Files section now says which settings they are and the exact command to remove each one, instead of just "Couldn't load files." Saving, uploading, renaming and deleting in that room say the same (DOR-2414).
- `dorkos harness sync` no longer says DorkOS moves skills on its own inside room folders. It only ever does that inside the agent folders it owns (DOR-2414).
