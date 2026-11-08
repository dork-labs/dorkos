---
covers:
  - 'fix(codex): agent folders get .agents and .mcp.json so Codex can edit there (DOR-3914)'
  - 'fix(codex): scaffold agent homes before creation reactions, and pin what is still missing (DOR-3914)'
---

### Fixed

- DorkOS now adds an `.agents` folder and an empty `.mcp.json` file to each agent's own folder, for new agents and existing ones. Codex on Linux needs both before it will edit there (DOR-3914).
- When Codex on Linux can't edit because a protected file is missing, it now names that file (DOR-3914).
