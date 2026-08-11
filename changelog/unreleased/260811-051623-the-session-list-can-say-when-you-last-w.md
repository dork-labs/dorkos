---
covers:
  - 'feat(server): the session list can say when you last wrote, or say nothing (DOR-1081)'
---

### Added

- Your list of recent conversations now carries the time **you** last wrote in each one,
  separately from the time the agent last touched it. Nothing looks different yet — this
  is the reading the sidebar will sort your day by, so your conversations stop shuffling
  around while your agents work. Claude Code conversations report it; Codex and OpenCode
  ones say nothing rather than guess, and those keep their current order (DOR-1081)
