---
covers:
  - 'fix(rooms): a room agent keeps its memory — the binding follows the real session'
---

### Fixed

- Agents no longer forget a room after half an hour of quiet. An agent answering in a room keeps one conversation there, so it remembers what was already said. That memory used to be filed under the wrong name: the room made up an id before the first reply, Claude Code then gave the conversation its own id, and nobody told the room. While the agent stayed busy nothing looked wrong. Thirty idle minutes later — or after a restart — the next message went looking for a conversation under the old name, found nothing, and started the agent from scratch. It said nothing about it and it happened again every quiet spell. The room now records the conversation the agent actually had, so it picks up where it left off.
