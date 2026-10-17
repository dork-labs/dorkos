---
covers:
  - 'feat(server): store doc comments and wake the agents they mention (DOR-2983)'
  - 'fix(docs): count a doc comment as a request only from the owner in person, and bound every wake (DOR-2983)'
  - "fix(docs): keep the owner's in-person comments the owner's, and hand back a failed wake's turn (DOR-2983)"
---

### Added

- Comments on markdown docs are kept beside the file, never in it. Mention an agent with `@handle` in a comment and it wakes up to answer in the thread; it can also read, open, reply to and resolve comments on its own. Only your own comments count as requests, and with login on only the ones you write in the app: anyone else's words reach the agent as information. Every wake counts against the same hourly limit as room replies, and agents mentioning each other stop at the same reply limits as rooms. You get a notification when an agent comments on one of your docs. Part of the Docs experiment, which is off by default (DOR-2983).
