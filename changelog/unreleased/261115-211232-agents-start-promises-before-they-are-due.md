---
covers:
  - 'feat(todos): agents start a promise before it is due, and the person hears when it moves (DOR-3034)'
---

### Changed

- An agent is now woken to start a promise before it is due, not at the due time. It can say roughly how long the work takes (an hour, half a day or a day) and is woken that long before, with a little to spare, and once more partway through to check in. With no guess it is woken an hour before.
- A promise still open 15 minutes after its due time is now marked missed then, not an hour after the agent was woken. If the computer was asleep or off, the agent still gets those 15 minutes after it wakes.

### Added

- When an agent moves or drops a promise it made to you, you hear about it in your Inbox, with its reason. A promise made to another agent tells that agent.
