---
covers:
  - 'fix(runtimes): agents write simpler shell commands, so fewer approval cards reach you (DOR-3109)'
---

### Fixed

- Agents are now told to run one shell command at a time, with no `cd` first and no inline variables. Claude Code can't check those before they run, so it was asking you about routine commands (DOR-3109)
- A spin-off chat that waits on CI is now told to wait with one plain command, not a shell loop, for the same reason (DOR-3109)
