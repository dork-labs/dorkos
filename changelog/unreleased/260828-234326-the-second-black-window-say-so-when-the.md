---
covers:
  - "fix(client): the second black window — say so when the server can't be reached (DOR-1475)"
---

### Fixed

- If DorkOS can't reach its server when it opens, it now says so and keeps
  trying. Before, you got an empty window — or, if you had used DorkOS before, a
  full screen rebuilt from what your browser remembered last time, where none of
  the rooms, agents or buttons in it actually worked. The new screen tells you
  the server may still be starting, has a Try again button, and clears itself
  the moment the server answers (DOR-1475)
- A server that has stopped answering without ever refusing the connection now
  gets the same screen, after fifteen seconds of silence, instead of leaving you
  in a window where everything you press hangs (DOR-1475)
- Opening DorkOS while its server was down could also drop you into the
  first-run setup screens, as if this were a brand new install — and anything
  you answered there had nowhere to be saved. It doesn't do that any more
  (DOR-1475)
