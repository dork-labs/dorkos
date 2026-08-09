---
covers:
  - 'fix(ui): one rendering for agent working state (DOR-1052)'
---

### Fixed

- **A green dot now means one thing: an agent is working right this second.** It
  used to light up whenever DorkOS had heard from an agent in the last hour, so
  faces all over the cockpit pulsed as if mid-turn when nothing was running.
  Agents that are simply alive show nothing at all, which is what makes the ones
  that do light up worth looking at.
- Every live dot in the app now says the same thing in the same colour: green and
  pulsing for working, amber for waiting on you, red for a failed turn, blue for
  output you have not read. They were four different greens and three different
  ambers, spread across the sidebar, the tab strip, the group headers and the
  agent panel.
- Only the working dot moves. A tab waiting for your approval used to pulse too,
  which read as a turn still running when it was actually stopped, waiting for
  you.
- **Agent faces stopped drawing a second, competing ring.** A coloured health ring
  sat two pixels outside the dot, both fed by the same hour-old signal — one fact
  drawn twice. Health now appears where it is actually useful: as "Online" or
  "Offline" in the agent panel, and as a labelled dot on the mesh map, which also
  gained a colour for agents it cannot reach at all.
- In the agent panel, the pencil that appears when you hover no longer covers the
  little robot mark on the avatar. It moved next to the name it renames, and the
  avatar answers your pointer with a ring in the agent's own colour instead.
