---
covers:
  - 'test(client): pin every shipped session activity label before the clause refactor (DOR-1351)'
  - 'refactor(client): the tool phrasing table becomes clauses, so one entry serves two grammars (DOR-1351)'
  - 'feat(shared): a room presence signal can carry what the turn is doing, minus its target outward (DOR-1351)'
  - 'feat(server): a room hears what its own turn is doing, throttled and cleared with the claim (DOR-1351)'
  - "feat(server): the glimpse's target stops at this cockpit, stripped at both outbound projections (DOR-1351)"
  - "feat(client): a room's lane says what one agent is doing, and its peek says it per agent (DOR-1351)"
---

### Added

- A room now tells you what an agent is doing, not just that it is doing something. While one agent works, the line under the message box reads "Kai is reading standup.md" instead of "Kai is working on it", and it keeps up as the agent moves from one thing to the next (DOR-1351)
- Click that line and each agent gets its own row saying what it is on right now, so with two or three of them working you can see which one to check first (DOR-1351)

### Changed

- The file names and commands an agent is working with stay on your own screen. If a room is connected to a chat app, or shared with another community, they see that an agent is "running a command" and never which one (DOR-1351)
- A screen reader still hears "Kai is working on it" once, and is not read a new tool name every couple of seconds (DOR-1351)
