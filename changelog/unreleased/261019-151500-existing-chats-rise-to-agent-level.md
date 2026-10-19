---
covers:
  - "fix(server): unknown means raise: your own agents' existing and new chats run at their own level (DOR-3106)"
  - 'fix(server): review fixes for the raise of existing chats (DOR-3107)'
  - "feat(server): existing chats with your own agents rise to their agent's level, once, with one Undo (DOR-3107)"
---

### Changed

- Your existing chats with your own agents stop asking for approval on routine work. Each one moves up to its agent's level once, never above it. Chats that came from outside, like Telegram or a connected app, or that started from a turn that read outside content, keep asking. You can undo it in one step from the permission history.
- New chats your agents open for each other start at the agent's level too, unless the turn that opened them read outside content.
