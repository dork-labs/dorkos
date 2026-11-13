---
covers:
  - 'fix(session): messages one agent queued for another run after a restart, and never join a stuck queue'
---

### Fixed

- A message one agent sent another no longer waits for days after DorkOS restarts. It runs as soon as DorkOS is back.
- A message sent to an agent that only looked busy no longer gets stuck behind an older message that would never run.
