---
covers:
  - 'feat(observability): one id follows a message from the room to the reply'
---

### Added

- One id now follows a message the whole way — from the room it was posted in, through the agent's turn, to the reply that comes back, and across a chat integration if it goes that far. Nothing you see in DorkOS changes. What changes is what happens when something goes quiet for forty minutes: the log can be narrowed to that one exchange, so the answer takes seconds instead of an afternoon.
