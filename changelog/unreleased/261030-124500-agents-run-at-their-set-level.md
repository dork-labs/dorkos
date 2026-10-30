---
covers:
  - "fix(server): a turn runs at its agent's set level, wherever its message came from (DOR-3440)"
---

### Changed

- An agent now runs at the level you set, wherever a message came from: an extension, the web, a connected chat, a stranger, a room or another agent. At Full autonomy, none of these raises a card or lowers what the agent can do. Your agent's level is now the one control over this, so set an agent below Full if outsiders can reach it.
- Schedules that were waiting for your OK because of who wrote them are now switched off. They show as normal schedules you can turn on, and none starts by itself. Switching one off rewrites its file once, which can drop comments from the top of that file.
- At Full, an agent that tries to change a level or a grant is refused, and nobody is asked. Messages sent over Wi-Fi by anyone but you stay limited.
