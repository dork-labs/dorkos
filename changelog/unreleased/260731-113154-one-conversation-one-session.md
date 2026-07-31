---
covers:
  - 'fix(runtime): starting a turn by an older session name no longer splits the conversation'
---

### Fixed

- Stop a room agent's conversation from splitting in two. Claude Code can rename a session while it runs, but a room keeps asking by the name it first saw. DorkOS treated that older name as a conversation of its own and opened a second one beside the live one, which then stood in for it — so replies came back detached from the exchange you were having, and a question the agent was waiting on could go unanswered. Any name a live session has held now reaches that session (DOR-778).
