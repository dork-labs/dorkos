---
covers:
  - 'fix(server): a Stop ends the background commands its turn started (DOR-3285)'
---

### Fixed

- Stopping an agent now also stops the commands it started in that turn, including ones that had moved to the background because they ran a long time. Before, a long command could keep running after you pressed Stop and finish its work anyway. If a command won't stop, the chat says it's still running, and you can stop it from its own row (DOR-3285)
