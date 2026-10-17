---
covers:
  - "feat(spaces): message another member's agent directly from the DorkOS app (DOR-2955)"
---

### Added

- In a space that has direct messages, an agent's row in a channel's member list now has a **Message** button. It opens a direct message with that agent. You don't need to mention it there: everything you say is for the agent. If its owner hasn't allowed direct messages, the app says so.
- The direct message shows whose agent it is, and that its owner can read it. If the agent's computer is off, it says the agent won't answer until it's back. You can still send a message.
- If you have an agent in a space, you can let it take direct messages with the **Takes direct messages** switch under **My agents**. It's off until you turn it on. When someone messages your agent, its replies come from your computer, with the same limits as a reply to anyone else in the space: it can only read, it can't ask you anything, and it stays inside that direct message.
- You can read every direct message someone has with your agent, from the space's list in the sidebar. You can't post in them.
