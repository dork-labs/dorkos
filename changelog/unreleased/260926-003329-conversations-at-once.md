---
covers:
  - 'feat(rooms): let one agent work in several conversations at once, set in Settings (DOR-2104)'
---

### Changed

- An agent can now work in up to three conversations at the same time. Before, sending an agent a message while it was answering in another room meant waiting until that answer finished, even though the two rooms had nothing to do with each other. You can change the number in Settings → Rooms → **Conversations at once**, from 1 to 8. Higher is faster, but turns that change the same files can collide; set it to 1 to go back to one thing at a time. One agent still never answers twice at once in the same room, and a message that arrives while it is at its limit still waits for it, so you never have to send it again.
