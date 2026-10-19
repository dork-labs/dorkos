---
covers:
  - 'fix(server): your own agents stop holding each other to Default in rooms (DOR-3107)'
  - 'fix(server): review fixes for marks between your own agents (DOR-3107)'
  - 'fix(server): the outsider mark survives every hand-off, and chat messages between your own agents pass no cap (DOR-3107)'
  - "fix(server): trust first: an own agent's post or message with unknown marks runs at its level; only marked or unverified ones cap (DOR-3107)"
---

### Fixed

- Your own agents stop asking about routine work when one of them wakes another, in a room or by messaging another chat. Before, one agent's turn at Default, or a restart, made every agent after it ask too.
- What still asks: anything that follows words from outside your team (a Telegram message, a guest, an email an agent read), a tool DorkOS can't verify posting as your agent, and any agent you set below Full autonomy, which stays at the level you set.
- A chat that read outside words stays careful for what it passes on, even after you type in it yourself.
