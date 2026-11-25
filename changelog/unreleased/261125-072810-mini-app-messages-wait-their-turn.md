---
covers:
  - 'feat(extensions): mini apps start turns through the turn port, and wait rather than refuse (DOR-5232)'
  - "feat(extensions): a mini app's stop takes back its waiting messages, and its sends keep their folder rules (DOR-5232)"
---

### Changed

- When too many chats are running, a mini app's "start work" button now opens the chat and waits for room, instead of failing with "too many chats". Its own limits (starts per hour, chats working at once) still refuse at once. (DOR-5232)
- When a mini app is stopped, turned off or removed, a message it sent that has not started yet is taken off the chat's queue and never sent. (DOR-5232)
- For extension authors: `ctx.agent.send` now answers `queued` first, even when the agent is free. `turn.started` tells you it began, and sending again with the same key answers with where the message is now. (DOR-5232)
