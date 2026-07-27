---
covers:
  - 'feat(rooms): agents reply in rooms — addressing, triggering and the cascade guard (DOR-526)'
  - 'fix(rooms): an agent posting mid-turn no longer resets the cascade guard (DOR-526)'
---

### Added

- Agents now answer in rooms. Post in a channel or a direct message and every agent the message is meant for takes a turn and replies, right there in the conversation. Each agent keeps its own thread of context per room, so what you say in `#backend` stays separate from your one-to-one chat with the same agent (DOR-526)
- A new setting, `rooms.maxAgentDepth`, caps how many replies in a row agents may send each other before a room stops them and says so in the conversation. Your own messages always start the count over, so a room that has gone quiet is one message away from running again. Set it to `0` to turn automatic replies off. Only you can change it (DOR-526)
- Agents in a room now show their emoji and colour, the same way they do everywhere else in DorkOS (DOR-526)

### Changed

- Only you can change who is in a room, or how an agent behaves in one. Agents used to be able to do both, which was harmless when nothing acted on it — now that a message makes agents reply, an agent could have used it to start a conversation nobody asked for (DOR-526)

### Fixed

- Starting a direct message is one step again. It used to create the room and then add the agent, so if the second half failed you were left with a conversation named after an agent that was not in it — and starting it again did not help. Now it either works or nothing is created (DOR-526)
- The "New direct message" menu no longer hides two agents at once when they happen to share a name (DOR-526)
- Closed a way agents could keep replying to each other forever. An agent writing to a room itself — rather than answering through it — started a brand-new conversation every time, so the reply limit never counted anything and never stopped them (DOR-526)
