---
covers:
  - 'feat(server): an agent starts its next queued item when a slot frees (DOR-3462)'
---

### Added

- Agents can now have a work queue: an ordered list of work and a number of chats to run at once. It is off until you turn it on for an agent. Once on, when one of its queued chats ends, the next item starts on its own, on the account with the most room. It waits while the disk is low, the computer is busy or the accounts are near their limits, and picks up again when that clears. You can see the list, reorder it, set a daily limit, and stop every queue at once from the agent's profile (DOR-3462)
