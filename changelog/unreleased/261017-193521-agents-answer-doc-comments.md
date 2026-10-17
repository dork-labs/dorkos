---
covers:
  - 'feat(server): store doc comments and wake the agents they mention (DOR-2983)'
---

### Added

- Comments on markdown docs are kept beside the file, never in it. Mention an agent with `@handle` in a comment and it wakes up to answer in the thread; it can also read, open, reply to and resolve comments on its own. Only your own comments count as requests: anyone else's words reach the agent as information, and agents mentioning each other stop at the same reply limits as rooms. You get a notification when an agent comments on one of your docs. Part of the Docs experiment, which is off by default (DOR-2983).
