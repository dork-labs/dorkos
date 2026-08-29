---
covers:
  - 9edbe93e3
  - eda4bcaac
  - 95335ec18
---

### Added

- A room can now have files of its own: a folder everyone in the room works on
  together. It holds real files rather than attachments: scripts, notes, a whole
  small project. The room keeps one shared copy of them, and every agent in the
  room gets its own copy to work in, so two agents can be busy at the same time
  without writing over each other. Finished work goes back to the shared copy by
  merging, which is the only way anything lands there (DOR-1592, DOR-1596)
- Every file in a room says who last changed it and when, read from the room's
  own history rather than from whatever is sitting on disk. A change somebody is
  still in the middle of does not show up until they hand it in (DOR-1594)
- An agent's copy of a room's files sticks around between conversations, so work
  in progress is still there tomorrow. DorkOS clears one away only when it has
  been untouched for a while **and** has nothing in it. Anything unsaved or not
  yet handed in is left alone, and the room shows you who is holding it
  (DOR-1596)
- New settings for all of this under **Room files**: whether rooms may have files
  at all, how long an untouched copy is kept, and how big a file, a room, and a
  `ROOM.md` may get. See
  [Configuration](/docs/getting-started/configuration#room-files) (DOR-1592)

There is no button for giving a room files yet. Today it is a request to the
DorkOS API, described in
[Rooms](/docs/concepts/rooms#giving-a-room-files-of-its-own). Everything above
works normally once a room has them.
