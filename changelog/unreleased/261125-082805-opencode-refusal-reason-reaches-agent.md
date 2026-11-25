---
covers:
  - 'fix(runtimes): an OpenCode refusal answers at once and tells the agent why (DOR-5248)'
---

### Fixed

- When DorkOS blocks a command an OpenCode agent tried to run, the agent now hears why at once. Before, the first block in a chat could take about a minute, and the agent only got a generic "permission rejected" message, so it often stopped instead of trying another way (DOR-5248).
