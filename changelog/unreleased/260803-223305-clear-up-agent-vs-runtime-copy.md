---
covers:
  - 'fix(client): rename runtime-sense "agent" copy to name runtimes, not agents (DOR-853)'
  - 'fix(client): rename subagent-sense "agent" copy to "subagent" (DOR-853)'
---

### Changed

- Cleared up copy that used "agent" for two different things at once. The
  sidebar's "Add more agents" row that actually opens the Runtimes tab now
  says "Connect more runtimes"; first-run setup, the Runtimes settings tab,
  and the status bar now name Claude Code, Codex, and OpenCode (or say
  "runtime") instead of "agent" there. Background-task labels for helper
  subagents now say "subagent" instead of "agent" too. Nothing about your
  fleet of named agents changed (DOR-853)
