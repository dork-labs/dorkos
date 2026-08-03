---
covers:
  - 'fix(sessions): move the settings row before the canonical id is announced (DOR-493, DOR-838)'
---

### Fixed

- If you had set a server-wide default for how much new sessions ask before
  acting, that default could overwrite the choice you made for one particular
  session, moments after you made it. Your choice for a session now always beats
  the default.
- Sending a second message while a brand-new session was still answering the
  first no longer counts as starting a whole second session.
