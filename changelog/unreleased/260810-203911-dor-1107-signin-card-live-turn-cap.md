---
covers:
  - 'fix(client): the live-turn cap holds even when a sign-in card leads the turn (DOR-1107)'
---

### Fixed

- A long chat with a sign-in card still waiting for you no longer grows without limit.
  DorkOS caps how much of an in-progress reply it holds in the browser. That cap
  stopped working whenever a sign-in card sat at the top of the reply, so a tab left
  open while an agent woke itself up over and over kept piling on and slowly got
  heavier. The cap now holds in that case too, and the sign-in link you walked away
  to use still stays on screen (DOR-1107)
