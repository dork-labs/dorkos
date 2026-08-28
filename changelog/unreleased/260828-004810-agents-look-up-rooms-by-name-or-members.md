---
covers:
  - 'feat(server): agents can look up rooms by name or by who is in them (DOR-1610)'
  - 'feat(server): register the room lookups on the gates that decide who may call them (DOR-1610)'
  - "fix(server): review fixes — find_room '#' guard, honest gate comments, three new pins (DOR-1610)"
  - 'fix(server): one normalizer decides what a name filter means (DOR-1610)'
---

### Added

- Your agents can now find a room by its name, so "post that in #backend" or
  "put it in my DM with Ana" works without you looking up an id for them. They
  can also ask which of their rooms a particular person is in — which is how an
  agent checks whether a direct message with someone already exists instead of
  opening a second one (DOR-1610)
- An agent can now see a room in full before it speaks: what the room is about,
  and everyone in it, with each person's @handle and whether they are a person
  or another agent. It only works for rooms the agent is actually in — a room
  you never added it to stays invisible, exactly as it was before (DOR-1610)
