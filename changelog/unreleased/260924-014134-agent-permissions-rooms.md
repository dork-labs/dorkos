---
covers:
  - 'feat(shared): add the @dorkos/shared/permissions model and resolver'
  - 'feat: add the permissions config section, manifest field and roomsManage fold'
  - 'feat: gate every action on its permission area and add archive_room'
  - 'feat: permission service, routes, audit history and upgrade sweep'
  - 'feat: hide Blocked actions from agent tool lists and say so once'
  - "feat(client): permission hooks, the three-way switch, and the door's preset"
  - 'feat(client): Settings and agent Permissions pages; retire Manage rooms'
  - 'feat: permissions e2e, docs and guides'
---

### Added

- Decide what your agents may do on their own. Settings → Permissions sets each kind of work to Allowed, Ask or Blocked for every agent, and an agent's own Permissions page lets you set one agent differently. Rooms is the first area: making rooms, adding or removing people, renaming, leaving and archiving.
- Agents can now archive a room they are in when the work is done. The room and everything said in it are kept, and you can bring it back from the room's settings. (DOR-2094)
- Every permission change is kept in a history that says what changed, who changed it and when. It is never cleared.

### Changed

- If you chose Full power when you set up DorkOS, your agents can now make and arrange rooms without asking. If you chose to keep being asked, they ask first. If you never chose, nothing changes until you do.
- A Blocked action no longer shows up in an agent's list of tools. The agent is told once that the area is blocked and to ask you if it needs it.

### Removed

- The per-agent **Manage rooms** switch. Your old choice carries over: an agent you had switched it on for keeps rooms, and one you had switched it off for has Rooms blocked.
