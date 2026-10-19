---
covers:
  - 'fix(server): room mentions wait behind an unanswered approval instead of failing (DOR-3113)'
---

### Fixed

- When an agent in a room is waiting for your approval, new mentions of it now wait until you answer, then get their reply. Before, each one failed with "ran into a problem", once per mention, for up to four hours.
- The room's note about the waiting approval now says to answer it in Needs you, and that new messages wait with it.
- If DorkOS can't send you a phone message about a waiting approval, for example because your Telegram connection is disconnected or isn't allowed to start conversations, the server log now says so instead of staying silent.
