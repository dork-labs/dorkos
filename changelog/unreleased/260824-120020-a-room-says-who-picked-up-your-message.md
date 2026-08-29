---
covers:
  - 'feat(server,shared,client): a room says who picked up your message, and who is working (DOR-786)'
---

### Added

- Sending a message to a room now tells you who it went to. The reply from the server names the agents the room asked to reply, and names the ones that will not be answering along with the reason — the back-and-forth hit its reply limit, that agent has already taken its turns in this exchange, or the agent is no longer set up on this machine. It is the room's first answer, not its last: if the room later changes its mind about one of those agents, it says so in the conversation the way it always has. A chat window can now explain why nothing is happening instead of just sitting there (DOR-786)

### Fixed

- Opening a room while an agent is working in it now shows that straight away, instead of after up to ten seconds of looking idle. The room's details panel had a worse version of the same problem: opened over a different room, it could never see who was working and quietly drew nothing, which looks exactly like a room where nobody is working. It now knows the difference, and says "No one is working right now" only when that is actually true (DOR-786)
- If an agent is taken out of a room while a message is still waiting for it, the room now says so. Before, the message was quietly dropped and nothing was written anywhere, so from inside the conversation it looked like the agent had simply ignored you (DOR-786)
