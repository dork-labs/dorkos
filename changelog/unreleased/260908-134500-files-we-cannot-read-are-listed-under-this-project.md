---
covers:
  - 'fix(harness): a placeholder harness stops being read as an answer (DOR-1891)'
  - 'fix(server): no chip for an agent tool the project does not run (DOR-1891)'
  - 'fix(harness): a heading for the project, not just for plugins (DOR-1891)'
  - 'fix(harness): a plugin-root warning names its own skill (DOR-1891)'
  - 'fix(server): a file a sync will write is never invisible (DOR-1891)'
  - 'feat(shared): the harness status response contract (DOR-1891)'
  - 'feat(server): one status model for every agent file (DOR-1891)'
---

### Fixed

- `dorkos harness sync` now lists files it could not read — a `.mcp.json` with a typo in it, a rule file whose header will not parse, a stale entry in your manifest — under a heading that says **this project**, instead of blaming whichever agent tool happened to be named first. A project that only runs Codex used to be told Claude Code had a problem, narrowing the report to one tool hid the warning completely, and turning on a plugin was never involved even though the old heading said "plugin layers".
