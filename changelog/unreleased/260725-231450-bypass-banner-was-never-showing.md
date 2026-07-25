---
covers:
  - 'fix(session): the permission-bypass banner reads the cache the app writes (DOR-482)'
---

### Fixed

- The standing warning that tells you a session is running with every permission bypassed — the agent free to run any tool without asking — was never appearing. It looked for the session's settings in a spot nothing ever saved them to, so it came up empty every time and stayed quiet. If you have run sessions in "Bypass All" mode, assume that warning was not showing. It now appears for the whole time a session is in that mode, and it shows up the moment you switch into it rather than waiting for the next thing to happen (DOR-482)
