---
covers:
  - "fix(server): editing a queued message's words no longer sticks when the move you asked for fails (DOR-1178)"
---

### Fixed

- Rewording a message waiting in the queue while also moving it now checks the move first.
  Before, a move to a bad spot (an anchor that no longer exists) could still fail after your
  new words had already been saved — you'd see an error, but your edit had gone through
  anyway with no notice to anyone watching the queue
