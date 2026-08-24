---
covers:
  - 'fix(server,client,shared): say when a stricter permission setting actually starts (DOR-1435)'
  - 'fix(server): Codex says when a stricter permission setting actually starts, too (DOR-1435)'
---

### Fixed

- Tell you when a stricter permission setting has not reached the reply that is already
  running. Turning approvals back on while an agent is mid-reply used to look like it took
  effect immediately, even when the running reply kept the looser setting it started with.
  The setting is still saved, and now the cockpit says plainly that it starts on your next
  message. Claude Code and Codex both report it (DOR-1435)
