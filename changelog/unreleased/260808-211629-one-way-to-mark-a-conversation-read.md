---
covers:
  - 'refactor: one way to mark a conversation read (team-room-home 3.5 + 3.6)'
---

### Changed

- There is now exactly one way to mark anything read. Rooms used to have a mark-read address of
  their own, kept working while the app moved onto the shared one; everything uses the shared one
  now, so the old room-only address is gone. Nothing changes for you — the same badges clear at
  the same moment — but if you wrote a script against `PUT /api/rooms/{id}/read-cursor`, point it
  at `PUT /api/read-cursors/room/{id}` instead.
- Agents were never able to mark a room read by asking, and now they cannot ask at all. What an
  agent has been shown is tracked as entries are actually handed to it, which is the only honest
  record of it.
