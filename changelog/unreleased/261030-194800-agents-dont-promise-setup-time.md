---
covers:
  - 'fix(server): agents never promise how long connecting an app takes (DOR-2850)'
---

### Fixed

- When an agent asks you to connect an app, it no longer tells you it will be quick or ready in a minute. Connecting waits on you, and you may need to sign in to the app first, so the agent now only says it asked and where you can answer.
