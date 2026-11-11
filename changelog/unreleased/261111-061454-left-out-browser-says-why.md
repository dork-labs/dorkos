---
covers:
  - "fix(server): an agent's MCP servers list says why a browser with a custom path or shared profile doesn't run (DOR-3207)"
  - "fix(client): a browser DorkOS doesn't run reads Not used on its card (DOR-3207)"
---

### Fixed

- An agent browser set up with a custom browser path or a shared profile no longer looks like it should work. Its card in the agent's MCP servers list reads "DorkOS uses its own browser for agents. Custom browser paths aren't allowed." (DOR-3207).
