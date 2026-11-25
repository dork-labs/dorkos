---
covers:
  - 'feat(extensions): mini apps start turns through the turn port, and wait rather than refuse (DOR-5232)'
  - "feat(extensions): a mini app's stop takes back its waiting messages, and its sends keep their folder rules (DOR-5232)"
  - "feat(extensions): a mini app's start survives a restart, and its owner hears when one never runs (DOR-5232)"
  - "fix(extensions): a mini app's first messages share one chat, and its queued messages survive an upgrade and a restart (DOR-5232)"
---

### Changed

- When too many chats are running, a mini app's "start work" button now opens the chat and waits for room, instead of failing with "too many chats". Its own limits (starts per hour, chats working at once) still refuse at once. (DOR-5232)
- A chat a mini app starts now runs even if DorkOS restarts before it begins. If it can never run (say no account may work in that project), you get one notice naming the app and why. (DOR-5232)
- When a mini app is stopped, turned off or removed, a message it sent that has not started yet is taken off the chat's queue and never sent. (DOR-5232)
- For extension authors: `ctx.agent.send` now answers `queued` first, even when the agent is free. `turn.started` tells you it began, and sending again with the same key answers with where the message is now. (DOR-5232)

### Removed

- For extension authors: `StartWorkResponse.warnings` is removed, and the extension-seam contract is now 2.0.0. `startWork` answers before the chat's turn starts, so it can no longer carry the no-tools notice for a Codex chat. That notice now shows in the app's activity line once the turn starts. (DOR-5232)
