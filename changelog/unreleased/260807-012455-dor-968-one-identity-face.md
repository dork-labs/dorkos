---
covers:
  - 'fix(identity): resolve every identity face through one shared function (DOR-968)'
  - 'refactor(identity): make the face contract explicit and stop overclaiming it (DOR-968)'
  - "fix(client): point the merged gutter's IdentityOrigin import at its new shared/lib home"
---

### Fixed

- One agent, one silhouette. The member list in a room's details and the row of faces at the top of the room used to draw the same agent two different ways — a bot mark on one and none on the other, both of them round, and two different colours for anyone the app could not look up. They agree now: same shape, same corner mark, and the same colour for anyone the app cannot look up. (DOR-968)
- Direct messages wear the agent they are with. In the sidebar, the room header and the ⌘K palette, a one-to-one now shows that agent's own square mark instead of a round one that made it look like a person. (DOR-968)
- The green "working now" dot on the identity card was being drawn twice for one fact. There is one dot now, on the avatar, where it is everywhere else. (DOR-968)
