---
covers:
  - 'feat(sessions): a chat starts chats at its own permission level or lower (DOR-2714)'
---

### Changed

- A chat an agent starts now runs at the same permission setting as the chat that started it, unless the agent asks for a lower one. Before, a chat at Full autonomy could only start chats that stopped to ask. Asking for a higher setting is turned down with a plain reason instead of being quietly lowered, and Full autonomy still needs your one-time okay. The new chat's first lines say which setting it got (DOR-2714)
