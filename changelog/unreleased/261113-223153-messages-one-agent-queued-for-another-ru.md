---
covers:
  - 'fix(session): messages one agent queued for another run after a restart, and never join a stuck queue (DOR-3287, DOR-3348)'
  - 'fix(session): give up on a recovered message after three failed starts, and pin the chain it carries'
  - "fix(session): a chat's queued messages resumed at boot run where the chat lives, as its agent (DOR-3287)"
---

### Fixed

- A message one agent sent another no longer waits for days after DorkOS restarts. It runs as soon as DorkOS is back, in that agent's own folder with its whole conversation.
- A message sent to an agent that only looked busy no longer gets stuck behind an older message that would never run.
