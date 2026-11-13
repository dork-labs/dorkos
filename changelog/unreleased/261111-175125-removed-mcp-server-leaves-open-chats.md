---
covers:
  - 'fix(server): a removed MCP server leaves chats already open on their next message (DOR-3872)'
---

### Fixed

- Removing an MCP server for every agent, turning it off, or keeping an agent from it now reaches chats that are already open, on their next message. You no longer need to restart DorkOS. A Codex chat in the middle of a reply can still finish that reply with the server. (DOR-3872)
