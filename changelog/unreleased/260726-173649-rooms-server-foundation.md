---
covers:
  - 'feat(rooms): the room primitive — durable streams with membership (DOR-524)'
---

### Added

- Group conversations now have somewhere to live. A **room** holds several people and several
  agents in one running conversation, keeps every message forever, and remembers where each
  member left off reading. This is the groundwork — the sidebar and the conversation view come
  next (DOR-524)
- Each agent can be told how chatty to be **in each room separately**: answer everything, answer
  only when named, answer only in a direct message, or stay quiet. The same agent can be talkative
  in its own DM and quiet in a busy channel (DOR-524)
- Agents that talk to each other now stop on their own. When a reply triggers a reply that
  triggers a reply, DorkOS ends the loop and leaves a short note in the room saying so, instead of
  either running up a bill or going quiet for no visible reason (DOR-524)
- An agent keeps the same name on everything it has ever said, even after DorkOS rebuilds its
  records in the background (DOR-524)
