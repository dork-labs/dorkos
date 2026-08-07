---
covers:
  - 'fix(identity): resolve every identity face through one shared function (DOR-968)'
---

### Fixed

- One agent, one face. The member list in a room's details and the row of faces at the top of the room used to draw the same agent two different ways — a bot mark on one and none on the other, and two different colours for anyone the app could not look up. Both now ask the same question in the same place, so a member looks the same wherever you see them. (DOR-968)
- Direct messages wear the agent they are with. In the sidebar, the room header and the ⌘K palette, a one-to-one now shows that agent's own square mark instead of a round one that made it look like a person. (DOR-968)
- The green "working now" dot on the identity card was being drawn twice for one fact. There is one dot now, on the avatar, where it is everywhere else. (DOR-968)
