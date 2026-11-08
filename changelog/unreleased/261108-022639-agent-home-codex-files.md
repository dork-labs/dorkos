---
covers:
  - 'fix(codex): agent folders get .agents and .mcp.json so Codex can edit there (DOR-3914)'
---

### Fixed

- On Linux, Codex can edit in an agent's own folder again. DorkOS now adds the two files Codex needs there, for new agents and existing ones (DOR-3914).
- When Codex still can't edit because a file is missing, it names that file and how to add it (DOR-3914).
