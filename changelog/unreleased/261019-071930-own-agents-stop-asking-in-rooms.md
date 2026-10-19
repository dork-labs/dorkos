---
covers:
  - 'fix(server): your own agents stop holding each other to Default in rooms (DOR-3107)'
  - 'fix(server): review fixes for marks between your own agents (DOR-3107)'
---

### Fixed

- In a room with only you and your own agents, an agent woken by another of your agents now works at its own level instead of asking about routine work. Before, one agent's turn at Default, or a restart, made every agent after it in the room ask too.
- What still asks: anything that follows words from outside your team (a Telegram message, a guest, an email an agent read), a post DorkOS can't vouch for, and any agent you set below Full autonomy, which stays at the level you set.
