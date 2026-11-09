---
covers:
  - 'feat(work-queue): gate queue controls and preserve requester authority'
---

### Added

- Let agents ask to configure work queues and queue work for another agent. Each increase needs your approval. Passed work keeps the sender’s limits, including when queued again. Agents can pause queues, lower limits, remove waiting work and reorder it without asking.
