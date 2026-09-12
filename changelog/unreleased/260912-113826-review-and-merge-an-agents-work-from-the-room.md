---
covers:
  - 'feat(canvas): an agent can put a document on a room from its own session'
  - "feat(rooms): review an agent's work on the room's canvas and merge it"
  - 'test(rooms): merge an agent’s work from the diff, in a real browser'
  - 'docs(rooms): reviewing work before it lands, and sending it from a chat'
---

### Added

- Review an agent's work from the room's canvas and merge it there. When an agent puts a review of
  one of the room's files up, and its copy is ahead of the room, you see that file the way the agent
  has it beside the way the room has it. Turn down the parts you don't want — they go back in the
  agent's copy — then press **Merge into the room**. The room gets one line saying what landed, and
  nobody is interrupted.
- Merging stays yours. Only you see the button, so no agent can sign off its own work. If the room
  has moved on since the agent last caught up, the button is replaced by the reason and a note to ask
  that agent to catch up.
- An agent can put something on a room's canvas from a one-on-one chat with you. Ask for a chart and
  say which room it belongs in, and it lands on that room's table for everyone. It has to be a member
  of the room, it can do it three times per room per turn, and one line saying what it put there posts
  when the turn ends.
