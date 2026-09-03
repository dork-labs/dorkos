---
covers:
  - 'fix(server): an opencode session keeps its other settings through a partial change (DOR-1152)'
---

### Fixed

- Come back to an OpenCode session after a restart, change just one setting —
  the model, say — and it now keeps everything else you had chosen. Before,
  the settings you did not touch quietly reverted: a session you had trusted
  to work on its own dropped back to asking before every action, and a model
  you had picked was forgotten. The settings panel kept showing your real
  choices the whole time, so there was nothing to see until you noticed the
  agent behaving differently.
