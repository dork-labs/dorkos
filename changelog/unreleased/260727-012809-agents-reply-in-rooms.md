---
covers:
  - 'feat(rooms): agents reply in rooms — addressing, triggering and the cascade guard (DOR-526)'
  - 'fix(rooms): an agent posting mid-turn no longer resets the cascade guard (DOR-526)'
  - 'fix(rooms): only a person starts a fresh cascade, and threads answer the roster rule (DOR-526)'
  - 'fix(rooms): bound room spend without asking who is calling (DOR-526)'
  - 'fix(rooms): cap total spend, bind sessions at claim, and stop the false notices (DOR-526)'
---

### Added

- Agents now answer in rooms. Post in a channel or a direct message and every agent the message is meant for takes a turn and replies, right there in the conversation. Each agent keeps its own thread of context per room, so what you say in `#backend` stays separate from your one-to-one chat with the same agent (DOR-526)
- A new setting, `rooms.maxAgentDepth`, caps how many replies in a row agents may send each other before a room stops them and says so in the conversation. Messages from you start the count over, so a room that has gone quiet is one message away from running again. Set it to `0` to turn automatic replies off (DOR-526)
- Two more settings put a ceiling on what automatic replies can cost you: `rooms.maxAutomaticTurnsTotalPerHour` (240 by default) caps how many DorkOS runs in an hour across every room you have, and `rooms.maxAutomaticTurnsPerRoomPerHour` (60) stops any single room using up that whole allowance. Both count no matter who the message looked like it came from, and the room says so when it stops. These are the ones that hold if **Require login** is off — see the note below (DOR-526)
- Agents in a room now show their emoji and colour, the same way they do everywhere else in DorkOS (DOR-526)

### Changed

- Changing who is in a room, or how an agent behaves in one, is now something only you can do. Agents used to be able to do both, which was harmless when nothing acted on it — now that a message makes agents reply, an agent could have used it to start a conversation nobody asked for (DOR-526)

### Security

- Worth knowing if you leave **Require login** off, which is the default. The two rules above that ask *who is writing* — the reply limit that only your messages reset, and the rule that only you change a room's members — depend on DorkOS being able to tell you from a program on your own computer, and with login off it cannot. A program that simply does not say it is an agent looks exactly like you. So treat those two as shaping how a room behaves, not as a guarantee about what it can spend. The hourly limits are what hold either way: they count every automatic reply regardless of who appeared to ask for it, and the total one is the real ceiling since rooms are free to make. Turning on **Require login** is what closes the gap (DOR-526, DOR-505)

### Fixed

- Sending two messages in a row no longer gives an agent two separate conversations with itself. Both replies used to start from scratch, and the second one quietly forgot everything — including what you had just said (DOR-526)
- Agents talking normally in a shared room no longer fill it with notices claiming somebody hit a reply limit they never came near (DOR-526)

- Starting a direct message is one step again. It used to create the room and then add the agent, so if the second half failed you were left with a conversation named after an agent that was not in it — and starting it again did not help. Now it either works or nothing is created (DOR-526)
- The "New direct message" menu no longer hides two agents at once when they happen to share a name (DOR-526)
- Closed two ways agents could keep replying to each other forever. An agent writing to a room itself — rather than answering through it — started a brand-new conversation every time, so the reply limit never counted anything and never stopped them. Messages from you are what start the count over now (DOR-526)
- Only you can open a thread that pulls in a second agent, the same rule that already applied to rooms (DOR-526)
