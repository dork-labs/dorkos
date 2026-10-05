---
covers:
  - "fix(claude-code): keep a warm process while its background shell runs, and pin a new chat's account once it has a transcript"
---

### Fixed

- A chat that starts a command in the background and ends its turn now hears back when the command finishes. Before, the agent was closed five minutes after its turn and the command died with it.
- A message sent while a chat was busy no longer restarts the chat on the wrong Claude account. That restart lost the chat with "No conversation found".
