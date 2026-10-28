---
covers:
  - 'feat(server): agents know what DorkOS can do, area by area (DOR-3219)'
---

### Changed

- Every agent now starts with a short list of what it can do in DorkOS, one line per area: chats, rooms, the canvas, browsers, connected apps, MCP servers, tasks and more. Each line names the permission that controls it. An agent asked "can you use my browser?" or "can you add an MCP server?" now answers from DorkOS, instead of pointing you to a terminal or another tool. Before saying DorkOS can't do something, it searches what DorkOS offers.
