---
covers:
  - 'feat(rooms): a claim lives until its turn is done, and knows what it is answering'
---

### Fixed

- An agent that takes a long time to answer in a room no longer counts as finished. A room waits 10 minutes for a reply. After that, the other agents in the room used to be told it was free, so two of them could start the same job. It now counts as working until its answer lands
- A room no longer names the same agent twice while it is working. One agent can have two replies going at once in a busy room, and each one was listed separately
- When a slow answer fails on its way into the room, the room now says the turn failed. Before, it went quiet and left you waiting for an answer that was never coming

### Changed

- If an agent posts to the room while it is still working on a slow reply, that post now counts as part of the same conversation. A question it asks another agent there gets picked up, where before it was quietly dropped. This can mean one extra reply in a conversation that used to end early
