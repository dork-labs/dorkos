---
covers:
  - 'feat(server): the session list can say when you last wrote, or say nothing (DOR-1081)'
  - 'fix(server): userLastMessageAt counts only what a person typed, and reaches back far enough to find it (DOR-1081)'
---

### Added

- Your list of recent conversations now carries the time **you** last wrote in each one,
  separately from the time the agent last touched it. Nothing looks different yet — this
  is the reading the sidebar will sort your day by, so your conversations stop shuffling
  around while your agents work. It counts only what a person actually typed: not a tool
  result, not a hand-off from another agent, and not a scheduled task firing overnight,
  which is why a conversation nobody typed in reports nothing at all. Claude Code
  conversations report it; Codex and OpenCode ones say nothing rather than guess, and
  those keep their current order (DOR-1081)
