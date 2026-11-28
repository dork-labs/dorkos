---
covers:
  - 'feat(tasks): scheduled tasks start turns through the turn port, and a fire at the limit waits (DOR-5219)'
---

### Changed

- A scheduled task that comes round while DorkOS is already running as many tasks as its limit allows now waits for a free slot and then runs. It used to be skipped. Its run history says it is waiting, and its time limit counts only once it starts (DOR-5219).
- A scheduled task's run now starts the way every chat's turn does, so it also waits while the computer is running as many agent chats as it allows. A task's run no longer sends a second "finished" notice for its chat beside its own (DOR-5219).
