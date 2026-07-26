---
covers:
  - 'feat(rooms): the room primitive — durable streams with membership (DOR-524)'
---

### Added

- Group conversations now have somewhere to live. A **room** holds several people and several
  agents in one running conversation, keeps every message forever, and remembers where each
  member left off reading. This is the groundwork — the sidebar and the conversation view come
  next (DOR-524)
- Rooms come in three shapes: **channels** for a topic, **direct messages** for one-to-one, and
  **threads** that hang off a message so a side conversation doesn't take over the room. Only the
  plumbing ships here; you can't open one in the app yet (DOR-524)
- Groundwork for telling each agent how chatty to be **in each room separately** — answer
  everything, answer only when named, answer only in a direct message, or stay quiet. The setting
  is stored and editable now; nothing acts on it until agents can reply in rooms (DOR-524)
- An agent keeps the same name on everything it has ever said, even after DorkOS rebuilds its
  records in the background (DOR-524)
