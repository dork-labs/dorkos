---
covers:
  - 'feat(rooms): one Direct chat per agent on the server (DOR-2997)'
  - 'feat(chat): one Direct chat per agent: you plus one agent always opens as a chat (DOR-2997)'
  - 'fix(chat): review fixes for the Direct chat (DOR-2997)'
---

### Changed

- Every agent now has one standing Direct chat with you. Clicking the agent, opening its chat, or tapping a message it sent you all lead there. It always opens as a normal chat, never as a room.
- Messages an agent sends you while it works elsewhere land in its Direct chat, with an unread dot on the agent. When you answer, the agent sees what it sent you, so "yes, go ahead" makes sense to it.
- Your old one-on-one direct messages with an agent now open as the start of that agent's Direct chat. Nothing was deleted. A direct message with two or more agents, or with another person, is still a room.
