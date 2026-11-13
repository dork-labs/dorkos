---
covers:
  - 'feat(server): read back who may use a global MCP server without asking (DOR-4118)'
  - "feat(server): a global MCP server's sheet can check its tools and mark new ones (DOR-4118)"
  - 'feat(server): Undo removes one standing yes for a global MCP server (DOR-4118)'
  - 'feat(server): the MCP server sheet routes: tools, standing yeses, and Undo (DOR-4118)'
  - 'feat(server): the Inbox says once when a global MCP server adds a tool an agent allows wholesale (DOR-4118)'
  - "fix(server): the tools check is a POST, and a server's tool list is capped (DOR-4118)"
  - 'feat(client): the MCP server sheet shows who uses it without asking, and what it can do (DOR-4118)'
---

### Added

- **See what an MCP server can do, and who uses it without asking.** Open a server under Connections → MCP servers to see its tools, checked when you open it, with a "New today" mark on any it just added. The same sheet lists every agent that may use the server, or one of its tools, without asking you first, and an Undo takes that back. If a server adds a tool that an agent already allows wholesale, your Inbox says so once.
