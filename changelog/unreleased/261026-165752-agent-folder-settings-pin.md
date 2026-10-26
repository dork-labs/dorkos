---
covers:
  - "fix(server): an agent can't change its own hooks, MCP servers or account without a person (DOR-3068)"
  - "fix(server): an agent's file tools can't rewrite an installed plugin (DOR-3068)"
  - "fix(server): close the pin's gaps: a renamed agent, plugin scripts, more settings that run code (DOR-3068)"
---

### Fixed

- An agent can no longer give itself more power by editing its own settings. Its file tools can't change its `.claude` folder, its `.mcp.json` or its agent file. If the agent changes its hooks, its MCP servers or its account some other way, like with a shell command, the change doesn't run. Its turns carry on with what you last allowed, and an approval card says what changed. Allow it, and the change applies from the agent's next turn. Turn it down, and you aren't asked again until the agent changes something else. Changes you make yourself in DorkOS, like picking an agent's account or adding an MCP server on its approval card, apply right away. The first time an agent runs after this update, DorkOS takes its current settings as the ones you allowed. An agent's file tools also can't change the plugins installed in any project, or the ones shared across them.
