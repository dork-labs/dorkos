---
covers:
  - 'feat(extensions): mini apps start turns through the turn port, and wait rather than refuse (DOR-5232)'
---

### Changed

- A mini app's message to a busy agent now waits its turn out of sight instead of sitting in the chat's queue, and starts as soon as the agent finishes. It still runs if DorkOS restarts while it waits. (DOR-5232)
- When too many chats are running, a mini app's "start work" button now opens the chat and waits for room, instead of failing with "too many chats". (DOR-5232)
- For extension authors: `ctx.agent.send` now answers `queued` right away, even when the agent is free. `turn.started` tells you it began. (DOR-5232)
