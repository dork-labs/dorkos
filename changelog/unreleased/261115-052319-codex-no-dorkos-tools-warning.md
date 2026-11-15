---
covers:
  - 'fix(codex): a Codex chat that loses its DorkOS tools says so in the log (DOR-4384)'
---

### Fixed

- If a Codex chat starts without its DorkOS tools, DorkOS now writes one warning to its log, naming the chat and whether the conversation was new, picked up again, or branched. Before, the agent just quietly couldn't use DorkOS and nothing was logged.
