---
covers:
  - 'feat(rooms): agents reply in rooms — addressing, triggering and the cascade guard (DOR-526)'
  - 'fix(rooms): an agent posting mid-turn no longer resets the cascade guard (DOR-526)'
  - 'fix(rooms): only a person starts a fresh cascade, and threads answer the roster rule (DOR-526)'
  - 'fix(rooms): bound room spend without asking who is calling (DOR-526)'
  - 'fix(rooms): cap total spend, bind sessions at claim, and stop the false notices (DOR-526)'
  - 'docs(rooms): say what the spend caps bound, and why the residual is acceptable (DOR-526)'
---

### Added

- Agents now answer in rooms. Post in a channel or a direct message and every agent the message is meant for takes a turn and replies, right there in the conversation. Each agent keeps its own thread of context per room, so what you say in `#backend` stays separate from your one-to-one chat with the same agent (DOR-526)
- A new setting, `rooms.maxAgentDepth`, caps how many replies in a row agents may send each other before a room stops them and says so in the conversation. Messages from you start the count over, so a room that has gone quiet is one message away from running again. Set it to `0` to turn automatic replies off (DOR-526)
- Two more settings put a ceiling on what automatic replies can cost you: `rooms.maxAutomaticTurnsTotalPerHour` (240 by default) caps how many DorkOS runs in an hour across every room you have, and `rooms.maxAutomaticTurnsPerRoomPerHour` (60) stops any single room using up that whole allowance. Both count no matter who the message looked like it came from, and the room says so when it stops. These are the ones that hold if **Require login** is off — see the note below (DOR-526)
- Agents in a room now show their emoji and colour, the same way they do everywhere else in DorkOS (DOR-526)

### Changed

- Changing who is in a room, or how an agent behaves in one, is now something only you can do. Agents used to be able to do both, which was harmless when nothing acted on it — now that a message makes agents reply, an agent could have used it to start a conversation nobody asked for (DOR-526)

### Security

- Worth knowing if you leave **Require login** off, which is the default. Two of the rules above work out *who is writing*: the reply limit that your messages reset, and the rule that only you change who is in a room. Both need DorkOS to tell you apart from a program running on your own computer, and with login off it cannot — a program that simply does not mention it is an agent looks exactly like you. Read those two as shaping how a room behaves, not as limits on what it can spend.

  **The hourly limits are the ones that hold either way**, because they never ask who is calling. The per-room limit caps what any one room runs; on its own that is not a cap on your bill, because a program that keeps making new rooms gets a fresh allowance each time. The total limit is the real ceiling: 240 automatic replies an hour across everything, however many rooms exist. Both reset if DorkOS restarts.

  None of this gives a program on your machine anything it did not already have — anything that can send these messages can run an agent directly. What these limits are really for is stopping well-behaved agents from talking each other in circles by accident, which is the common case and worth having on its own. Turning on **Require login** is what tells you and a program apart (DOR-526, DOR-505)

### Fixed

- Sending two messages in a row no longer gives an agent two separate conversations with itself. Both replies used to start from scratch, and the second one quietly forgot everything — including what you had just said (DOR-526)
- Agents talking normally in a shared room no longer fill it with notices claiming somebody hit a reply limit they never came near (DOR-526)

- Starting a direct message is one step again. It used to create the room and then add the agent, so if the second half failed you were left with a conversation named after an agent that was not in it — and starting it again did not help. Now it either works or nothing is created (DOR-526)
- The "New direct message" menu no longer hides two agents at once when they happen to share a name (DOR-526)
- Closed two ways agents could keep replying to each other forever. An agent writing to a room itself — rather than answering through it — started a brand-new conversation every time, so the reply limit never counted anything and never stopped them. Messages from you are what start the count over now (DOR-526)
- Only you can open a thread that pulls in a second agent, the same rule that already applied to rooms (DOR-526)
