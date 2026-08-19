---
covers:
  - 'refactor(client): the tool phrasing table becomes clauses, so one entry serves two grammars (DOR-1351)'
  - 'feat(shared): a room presence signal can carry what the turn is doing, minus its target outward (DOR-1351)'
  - 'feat(server): a room hears what its own turn is doing, throttled and cleared with the claim (DOR-1351)'
  - "feat(server): the glimpse's target stops at this cockpit, stripped at both outbound projections (DOR-1351)"
  - "feat(client): a room's lane says what one agent is doing, and its peek says it per agent (DOR-1351)"
  - "fix(server,shared): a released claim's done frame carries no reading, and a burst that ends where it started costs no frame (DOR-1351)"
---

### Added

- A room now tells you what an agent is doing, not just that it is doing something. While one agent works, the line just above the box you type in reads "Kai is reading standup.md" instead of "Kai is working on it", and it keeps up as the agent moves from one thing to the next (DOR-1351)
- Click that line and each agent gets its own row saying what it is on right now, so with two or three of them working you can see which one to check first (DOR-1351)
- A screen reader hears "Kai is working on it" once and is not read a new tool name every couple of seconds, so the new detail costs nothing in noise (DOR-1351)
- The file names and commands an agent is working with stay on your own screen. They are not sent to a chat app a room is connected to, or to another community a room is shared with (DOR-1351)
