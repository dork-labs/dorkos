---
covers:
  - 'feat(server): OpenCode subagent runs show up in the cockpit like every other runtime (DOR-1109)'
  - 'fix(server): read a stopped OpenCode subagent as stopped, not failed (DOR-1109)'
---

### Added

- When an OpenCode agent hands work to one of its subagents, you can now see it happening. The
  subagent shows up in the activity feed with its own card, the "working" line counts it while it
  runs, and the card keeps a running tally of the tools the subagent has used. Before this, a turn
  that delegated looked exactly like one that did not. Stop the turn part way and the subagent is
  marked stopped, not failed (DOR-1109)
