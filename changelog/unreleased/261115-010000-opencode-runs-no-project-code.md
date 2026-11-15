---
covers:
  - 'fix(opencode): the shared OpenCode sidecar no longer runs a cloned project’s own plugins, tools or MCP servers (DOR-4394)'
---

### Fixed

- OpenCode chats no longer run a project's own add-ons. A project you clone can't run its own code beside your other OpenCode chats. The project's `AGENTS.md` instructions still reach the agent.
