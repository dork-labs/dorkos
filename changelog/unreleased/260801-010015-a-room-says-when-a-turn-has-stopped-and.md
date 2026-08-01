---
covers:
  - 'feat(rooms): a room says when a turn has stopped, and gives you a way to stop it'
---

### Added

- Rooms now tell you when an agent has gone quiet because it is waiting on you. If it stops to ask permission for a tool, or asks a question, and nobody has answered a minute later, the room says so and points you at its session — instead of sitting there looking busy until the request quietly expires. Quick approvals stay quiet, so a room does not fill up with notes about pauses that lasted seconds.
- Every room has a **Stop** button in its header while agents are working. It stops the work; it is not something you can ask for in a message, because an agent stuck in a loop will just reply to that.

### Fixed

- An agent in several rooms at once no longer starts a separate job for each one in the same project folder. It finishes what it is doing first, and the other rooms say it is busy elsewhere rather than going silent.
- A room could mistake somebody else's work on the same agent for its own answer and post it. It now tracks exactly which piece of work it asked for.
