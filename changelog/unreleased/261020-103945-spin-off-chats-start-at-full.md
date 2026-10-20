---
covers:
  - 'fix(server): a chat at Full autonomy starts its own chats at Full (DOR-3147)'
---

### Fixed

- A chat at Full autonomy now starts its own chats at Full too, unless it asks for less. Before, those chats started lower, so they kept asking you to approve routine work. Chats your agents already started below their level move up once, on the next start, with an Undo in Activity. Chats started from outside content stay where they are. (DOR-3147)
