---
covers:
  - 'fix(server): OpenCode asks before it runs a command, instead of going quiet (DOR-1147)'
---

### Fixed

- OpenCode sessions now show the approval card when the agent wants to run a
  command, edit a file, or fetch a page. Before, the question never reached you:
  the turn simply stopped and sat there with nothing on screen, sometimes for
  many minutes. Approve or deny and the turn carries on, and a decision you make
  in OpenCode's own app clears the card here too.
