---
covers:
  - 'feat(server): agents catch up on what they missed in a room (DOR-665)'
---

### Added

- Agents now know what was said in a room while they were not answering. When an agent takes
  a turn, it is shown the messages it has not seen yet — not only the one that woke it up —
  so an agent pulled into a busy channel arrives knowing what the conversation is about
  instead of reading one line out of fifty. Listening still costs nothing: a message that
  addresses nobody starts no turn (DOR-665)

### Changed

- An agent is never shown messages from before it joined the room, and one turn catches up on
  at most the last 30 messages, so the first turn in a long-running channel no longer replays
  the whole history. When older messages are left out, the agent is told so
- A turn no longer sees the same message twice. The agent's place in the conversation moves
  the moment its turn starts, so a turn that fails or runs out of time does not repeat itself
  on the next one
