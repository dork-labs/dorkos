---
covers:
  - 'fix(codex): agent folders get .agents and .mcp.json so Codex can edit there (DOR-3914)'
  - 'fix(codex): scaffold agent homes before creation reactions, and pin what is still missing (DOR-3914)'
  - 'fix(codex): agent folders get every protected file Codex needs, so it can edit there (DOR-3914)'
---

### Fixed

- On Linux, Codex can edit in an agent's own folder again. DorkOS now adds the empty files and folders Codex needs there, for new agents and existing ones. They stay protected from agents' file tools (DOR-3914).
- When Codex on Linux can't edit because a protected file is missing, it now names that file (DOR-3914).
