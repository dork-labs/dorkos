---
covers:
  - "fix(server): a held turn can't change NOPE.md or its switch, at Full too (DOR-3440)"
  - "fix(server): a turn runs at its agent's set level, wherever its message came from (DOR-3440)"
  - "fix(server): a teammate's message lowers nothing; the mark only counts spend (DOR-3440)"
  - "fix(server): a lowered agent's edit waits, on every load; a record ceiling never raises a mode (DOR-3440)"
---

### Changed

- An agent now runs at the level you set, wherever a message came from: an extension, the web, a connected chat, a stranger, a room, another agent or another person in a shared space. At Full autonomy, none of these raises a card or lowers what the agent can do. Anyone who can message an agent gets that agent's level, including its files, notes and your profile, so check your DM policy, and set an agent below Full if outsiders can reach it. This is a preview; separate protections come later.
- Schedules that were waiting for your OK because of who wrote them are now switched off. They show as normal schedules you can turn on, and none starts by itself. Switching one off rewrites its file once, which can drop comments from the top of that file.
- At Full, an agent that tries to change a level or a grant is refused, and nobody is asked. Messages sent over Wi-Fi by anyone but you stay limited.
