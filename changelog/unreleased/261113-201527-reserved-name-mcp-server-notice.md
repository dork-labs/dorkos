---
covers:
  - "fix(mcp): a server whose name is reserved says why agents can't use it (DOR-4262)"
---

### Fixed

- An MCP server you added for every agent, whose name is now one of DorkOS's own, says why your agents can't use it. Its row on Connections reads "Agents can't use it · its name is reserved". Its sheet explains it and offers **Remove and add again…**, which opens Add with the same command so you only pick a new name. The tool check says it works, but agents can't use it until it's renamed. The Inbox tells you once when DorkOS finds such a server. (DOR-4262)
