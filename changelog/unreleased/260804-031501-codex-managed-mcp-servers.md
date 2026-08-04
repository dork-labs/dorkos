---
covers:
  - "feat(codex): inject an agent's managed MCP servers into Codex sessions (DOR-892)"
---

### Added

- Codex agents can now use managed MCP servers too, the same way Claude Code agents already can. Add one from a Codex agent's Toolkit tab: point it at a local command or a remote URL, turn it on or off, and DorkOS makes it available to the agent on its next turn. Codex doesn't support the third kind of server (a persistent streaming link, SSE), so that option isn't offered when you're adding a server to a Codex agent.
