---
covers:
  - 'fix(search): open the right session from a search result on every runtime'
---

### Fixed

- Opening a message-search result now takes you to the conversation it came from, whichever agent ran it. Results from Codex and OpenCode carried the id those tools use internally, which DorkOS could not open, so pressing Enter on one led nowhere.
- A result from a conversation you had at the command line, which DorkOS never ran, now says so instead of offering a link that opens an empty screen. The message is still found and still shown.
