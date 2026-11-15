---
covers:
  - 'fix(claude-code): the model-list warm-up loads only your own Claude settings, never the default folder’s project ones (DOR-4409)'
---

### Fixed

- When DorkOS starts, it asks Claude Code for the list of models. That check no longer loads the project settings of your default folder, so a project's hooks and tools never run before you have looked at them.
