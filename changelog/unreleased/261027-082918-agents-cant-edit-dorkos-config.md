---
covers:
  - "fix(server): an agent's file tools can't change DorkOS's settings file or another agent's setup (DOR-3068)"
---

### Fixed

- An agent's file tools can no longer change DorkOS's own settings file, where your approvals are kept, or the files that give any agent in DorkOS's data folder its powers: its settings, its MCP servers and its agent file. This holds on every chat, at every permission level. Agents can still edit their skills and instructions.
