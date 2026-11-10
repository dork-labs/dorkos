---
covers:
  - 'feat(work-queue): gate queue controls and preserve requester authority'
  - "feat(work-queue): agents can change work queues with a person's Ask, and cross-agent work runs at the lower level"
  - "fix(work-queue): a marked turn's refused queue change leaves the Full Activity line, and Always allow stays off safely"
  - 'test(db): the turn_context down test migrates only through turn_context'
---

### Added

- Let agents ask to configure work queues and queue work for another agent. Each increase needs your approval. Passed work keeps the sender’s limits, including when queued again. Agents can pause queues, lower limits, remove waiting work and reorder it without asking.
