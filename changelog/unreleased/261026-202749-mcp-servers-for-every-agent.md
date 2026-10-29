---
covers:
  - 'feat(server): MCP servers a person adds once for every agent (DOR-3213)'
---

### Added

- DorkOS can now keep a list of MCP servers that every agent gets, on Claude Code, Codex and OpenCode (Codex and OpenCode skip a server that only speaks SSE). You can leave out the agents you choose. An agent's own server with the same name takes its place for that agent. Tokens, keys and other secrets you type in are stored encrypted, and DorkOS never shows them again, to you or to an agent. Only you can add or change these servers, at this computer. The Connections page for them comes in a later release.
