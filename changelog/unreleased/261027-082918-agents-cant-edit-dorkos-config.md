---
covers:
  - "fix(server): an agent's file tools can't change DorkOS's settings file or another agent's setup (DOR-3068)"
  - 'fix(server): on every launch deny only the four agent authority files (DOR-3068)'
  - "fix(server): an agent's file tools can't change another agent's skills, commands or subagents (DOR-3068)"
---

### Fixed

- An agent's file tools can no longer change DorkOS's own settings file, where your approvals are kept. They also can't change the files that give an agent in DorkOS's data folder its powers: its settings, its MCP servers, its agent file, and its skills, commands and subagents. This holds on every chat, at every permission level. Agents can still edit their own instructions, and skills in a project's own folders.
