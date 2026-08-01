---
covers:
  - 'feat(observability): one id follows a message from the room to the reply'
  # Corrections to the above, before any of it shipped: the id was being opened
  # for things that were not dispatches, left open when a turn never started,
  # and — the one that mattered — stamped onto refusals belonging to a DIFFERENT
  # dispatch. Nobody ever ran a version with those defects, so they are part of
  # this entry rather than a "Fixed" bullet about a bug that never reached anyone.
  - 'fix(observability): a dispatch is opened only for a real one, and closed however it ends'
---

### Added

- One id now follows a message the whole way — from the room it was posted in, through the agent's turn, to the reply that comes back, and across a chat integration if it goes that far. Nothing you see in DorkOS changes. What changes is what happens when something goes quiet for forty minutes: the log can be narrowed to that one exchange, so the answer takes seconds instead of an afternoon.
