---
covers:
  - 'fix(server): a finished /compact no longer reports the agent as crashed (DOR-1235)'
---

### Fixed

- Asking your agent to shorten a long conversation used to end with a red "stopped unexpectedly" card, even though the shortening had worked. Nothing was actually broken — a shortening finishes without the agent saying anything, and that silence was being read as a crash. It now counts as the finished job it is. If the conversation gets shortened on its own in the middle of an answer and the agent then says nothing, you are still told (DOR-1235)
- When a shortening genuinely fails, you now get one message telling you why, instead of that message plus a second, vaguer one saying the agent did not respond (DOR-1235)
