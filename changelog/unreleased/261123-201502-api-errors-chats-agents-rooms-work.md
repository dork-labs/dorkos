---
covers:
  - 'feat(api): chats, agents, rooms and work answer errors as problem documents (DOR-4979)'
---

### Changed

- More of the DorkOS API now answers errors in the standard `application/problem+json` format: chats, agent programs, agents and the team, rooms and direct chats, profiles, tasks, to-dos, the work queue, terminals, diffs, notifications, activity and settings. Each answer carries `code`, the kind of problem, and `detail`, a sentence about what went wrong (DOR-4979)

### Note for people upgrading

- **This is a breaking change for scripts that call these parts of the API directly.** The old `error` field is gone from their error answers: read `code` for the kind of problem and `detail` for the message. Codes are now lower case with underscores, so `SESSION_LOCKED` is `session_locked`. Extra facts, such as which agent is paused, sit beside `code` in the same answer. The DorkOS app, the `dorkos` command and the desktop app already read the new format (DOR-4979)
