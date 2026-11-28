---
covers:
  - 'feat(runs): wakes are saved with the change that causes them, one per event (DOR-5215)'
  - "feat(runs): wake doors are handed in, and the click's id is minted by the transport (DOR-5215)"
  - 'feat(runs): a wake lets go of its words when its run ends, and has one reader (DOR-5215)'
---

### Changed

- A widget button clicked while the agent is still replying now waits for the reply to finish, for up to five minutes, instead of failing with "Wait for the reply to finish". A click that waits longer than that is dropped, so it never runs against a later reply (DOR-5215).

### Fixed

- An approval answered late, a browser handed back, a finished sign-in, a widget click and a to-do's turn are no longer lost when DorkOS restarts before the agent starts on them, and none of them starts the agent twice (DOR-5215).
