---
covers:
  - "fix(server): a subagent's permission ask reaches you, on the session's card (DOR-1126)"
---

### Fixed

- When an OpenCode agent hands work to a subagent and that subagent needs
  permission to run a command or change a file, the ask now reaches you. It
  appears in the session with the subagent's name on it, and answering it lets
  the subagent carry on. Before, the question was raised somewhere nothing could
  show it: the turn went quiet and waited, sometimes for many minutes, with
  nothing on screen to answer. Stop the turn while a subagent is waiting on you
  and the ask is taken down instead of sitting there unanswerable.
- An OpenCode subagent you stopped while it was waiting for permission now says
  it was stopped. It used to say it failed, right when there was nothing else on
  screen to tell you otherwise.
