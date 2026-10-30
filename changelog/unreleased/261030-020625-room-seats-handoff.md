---
covers:
  - 'feat(server): one seat per agent per room, and posts from other chats go to it (DOR-3397)'
  - 'chore(api): the OpenAPI doc lists the two hand-off notice codes (DOR-3397)'
  - 'fix(server): a hand-off turn is held by the room it reads, and its draft is fenced (DOR-3397)'
---

### Changed

- Each agent now has one voice in each room. Only the agent's own chat in a room posts there. If one of its other chats tries to post, the message goes to that room's chat instead. That chat reads the room first, then posts the message or says why not.
- A message passed on this way says where it came from, like "Shared from #team-product at Dorian's request". The room it came from gets a short line saying whether it was shared.
- An agent that isn't in a room can't post there, and isn't added for you. It says so and tells you to ask the person who runs DorkOS.
