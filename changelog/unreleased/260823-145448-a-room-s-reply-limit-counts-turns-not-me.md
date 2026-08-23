---
covers:
  - "feat(server,db): a room's reply limit counts turns, not messages (DOR-1434)"
---

### Changed

- An agent's progress notes no longer eat its reply allowance (DOR-1434). "How many replies from one agent" now counts **turns**: if an agent says "looking at the migration" and "found it" before it answers, that is one reply, not three. Agents that tell you what they're doing used to run out of room three times faster than agents that said nothing until the end, which was backwards. Messages posted before this change still count one each, so nothing about your existing rooms is re-scored.
