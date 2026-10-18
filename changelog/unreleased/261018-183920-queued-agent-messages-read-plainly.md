---
covers:
  - 'fix(server): a queued message from another agent shows its words, not our model wrapper (DOR-3060)'
---

### Fixed

- A message another agent queues in a busy chat now shows its own words in the queue, instead of the block of instructions DorkOS wraps it in for the agent. Message search shows the same words. The agent still gets the full wrapper, which keeps it from mistaking another agent's words for yours.
