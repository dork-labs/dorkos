---
covers:
  - 'fix(claude-code): no 30-second wait after a helper the agent waited on, and agents hear when their timers were stopped (DOR-3755)'
  - 'fix(claude-code): the stopped-timers note rides beside a stop note, and a pause adds none (DOR-3755)'
---

### Fixed

- After an agent ran a helper or a command and waited for it to finish, the next message to that chat could sit for 30 seconds before it started. The same happened after some of Claude Code's own housekeeping. In the common case the message now starts right away (DOR-3755).
- When an agent picked a helper back up, a late report from the helper's earlier run could make DorkOS think the helper had finished while it was still working. DorkOS now tells the two runs apart (DOR-3755).
- When DorkOS closes a chat's process to make room for another chat, a reminder the agent set for itself in that chat stops with it. The agent's next turn now says so, so it can set the reminder again instead of assuming it went off. Pausing an agent yourself adds no such note (DOR-3755).
