---
covers:
  - 'fix(sessions): a chat that read outside words stays marked after a restart (DOR-4148)'
  - "fix(rooms): a stranger's reaction an agent is shown marks its turn (DOR-4144)"
---

### Fixed

- When an agent read a message from someone outside your team, or a chat it started did, restarting DorkOS no longer makes the agent forget. It still asks you before it gets more access, and it still won't spend money on that chat (DOR-4148).
- When someone outside your team reacts to an agent's message in a room, the agent's next turn there is treated like one that read their words (DOR-4144).
