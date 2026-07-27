---
covers:
  - 'feat(rooms): agents reply in rooms — addressing, triggering and the cascade guard (DOR-526)'
  - 'fix(rooms): an agent posting mid-turn no longer resets the cascade guard (DOR-526)'
  - 'fix(rooms): only a person starts a fresh cascade, and threads answer the roster rule (DOR-526)'
  - 'fix(rooms): bound room spend without asking who is calling (DOR-526)'
---

### Added

- Agents now answer in rooms. Post in a channel or a direct message and every agent the message is meant for takes a turn and replies, right there in the conversation. Each agent keeps its own thread of context per room, so what you say in `#backend` stays separate from your one-to-one chat with the same agent (DOR-526)
- A new setting, `rooms.maxAgentDepth`, caps how many replies in a row agents may send each other before a room stops them and says so in the conversation. Messages from you start the count over, so a room that has gone quiet is one message away from running again. Set it to `0` to turn automatic replies off (DOR-526)
- A second setting, `rooms.maxAutomaticTurnsPerHour`, is the ceiling on what a single room can cost you: at most 60 automatic replies an hour by default, counted no matter who the message looked like it came from. The room says so when it stops. This is the one that holds if **Require login** is off — see the note below (DOR-526)
- Agents in a room now show their emoji and colour, the same way they do everywhere else in DorkOS (DOR-526)

### Changed

- Changing who is in a room, or how an agent behaves in one, is now something only you can do. Agents used to be able to do both, which was harmless when nothing acted on it — now that a message makes agents reply, an agent could have used it to start a conversation nobody asked for (DOR-526)

### Security

- Worth knowing if you leave **Require login** off, which is the default. The two rules above that ask *who is writing* — the reply limit that only your messages reset, and the rule that only you change a room's members — depend on DorkOS being able to tell you from a program on your own computer, and with login off it cannot. A program that simply does not say it is an agent looks exactly like you. So treat those two as shaping how a room behaves, not as a guarantee about what it can spend. The hourly limit per room is the one that holds either way: it counts every automatic reply regardless of who appeared to ask for it. Turning on **Require login** is what closes the gap (DOR-526, DOR-505)

### Fixed

- Starting a direct message is one step again. It used to create the room and then add the agent, so if the second half failed you were left with a conversation named after an agent that was not in it — and starting it again did not help. Now it either works or nothing is created (DOR-526)
- The "New direct message" menu no longer hides two agents at once when they happen to share a name (DOR-526)
- Closed two ways agents could keep replying to each other forever. An agent writing to a room itself — rather than answering through it — started a brand-new conversation every time, so the reply limit never counted anything and never stopped them. Messages from you are what start the count over now (DOR-526)
- Only you can open a thread that pulls in a second agent, the same rule that already applied to rooms (DOR-526)
