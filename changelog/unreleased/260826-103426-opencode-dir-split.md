---
covers:
  - 'refactor(opencode): split the runtime dir under the 25-file cap (DOR-1575)'
---

### Changed

- Moved the OpenCode runtime's model/provider files (model catalog and tiers, OpenRouter, Ollama detection and provisioning, dependency checks) into their own `providers/` subdirectory. The parent directory had crept to 26 files, over the repo's 25-file cap, which blocked the local pre-commit hook for anyone whose commit touched it (DOR-1575)
