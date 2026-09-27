---
covers:
  - 'Show usage and context the moment a session opens (DOR-2385)'
  - 'fix(sessions): keep turn readings and per-token usage honest (DOR-2385)'
---

### Changed

- A Claude Code session on a subscription now shows how much of its plan is used as soon as you open it, before it has run anything, and every open session on the same account updates together when new usage comes in. This works with a single account too
- How full a session's context is now shows when you reopen it and after DorkOS restarts, instead of waiting for the next reply
