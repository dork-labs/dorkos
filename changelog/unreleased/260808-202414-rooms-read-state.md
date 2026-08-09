---
covers:
  - 'feat(rooms): move room read state onto the one place a person is read (team-room-home 3.3)'
---

### Changed

- Your place in a room is now kept in the same place as your place in everything else you read.
  Nothing looks different: the unread dot in the sidebar, the count in the browser tab and the
  "New messages" line all sit exactly where they did, and reading a room on your laptop still
  clears it on your phone straight away. What changed is underneath — a room no longer keeps its
  own separate copy of where you are, so there is one answer to "have I read this" instead of one
  per surface. Rooms you had already read stay read when you upgrade
- An agent working through a room can never move your unread mark, and you can never move its
  own. An agent keeps its own record of what it has been shown, which is what lets it catch up on
  a busy channel without repeating itself — that is a different thing from what you have looked
  at, and the two are now kept apart on purpose
