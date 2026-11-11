---
covers:
  - "fix(server): a held MCP server change can't undo a narrowing, and the audit says when nothing changed (DOR-3836)"
---

### Fixed

- When you change an MCP server for every agent and confirm it's you, DorkOS now checks the server is still the same first. If someone kept an agent from it while the "Confirm it's you" sheet was open, the change is refused instead of undoing that. The Activity log also no longer says "Confirmed" for a change that was refused. (DOR-3836)
