---
covers:
  - 'fix(server): a Stop ends the background commands its turn started (DOR-3285)'
  - 'fix(server): a Stop that leaves commands running keeps a line under the turn, each with its own Stop (DOR-3285)'
---

### Fixed

- Stopping an agent now also stops the commands it started in that turn, including ones that had moved to the background because they ran a long time. Before, a long command could keep running after you pressed Stop and finish its work anyway. If a command won't stop, a line under the stopped reply names it with its own Stop button, and a pill at the top says how many are still running. The line stays after a reload and says when everything has ended (DOR-3285)
