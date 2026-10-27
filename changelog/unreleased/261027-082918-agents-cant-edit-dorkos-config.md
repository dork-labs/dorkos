---
covers:
  - "fix(server): an agent's file tools can't change DorkOS's settings file or another agent's setup (DOR-3068)"
---

### Fixed

- An agent's file tools can no longer change DorkOS's own settings file, where your approvals are kept, or the setup files of any agent in DorkOS's data folder. This holds on every chat, at every permission level.
