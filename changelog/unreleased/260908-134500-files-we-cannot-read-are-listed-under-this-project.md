---
covers:
  - 'fix(harness): a placeholder harness stops being read as an answer (DOR-1891)'
  - 'fix(server): no chip for an agent tool the project does not run (DOR-1891)'
---

### Fixed

- When DorkOS cannot read one of your project's files — a `.mcp.json` with a typo in it, say — it now says so under its own heading instead of blaming whichever agent tool happened to be named first. A project that only runs Codex used to be told Claude Code had a problem, and narrowing the report to one tool hid the warning completely.
