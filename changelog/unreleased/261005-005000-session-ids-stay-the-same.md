---
covers:
  - 'fix(sessions): a started session keeps the id it was given, and an unknown id is a 404 (DOR-2712)'
  - 'fix(sessions): review fixes — retries still create, chip reads the session record, docs (DOR-2712)'
  - 'fix(sessions): second-round review fixes (DOR-2712)'
---

### Fixed

- When an agent started a session for you, the id it got back could stop working later. A message sent to that id then started a new, empty chat in your home folder instead of reaching the right one. Now a session keeps the id it was started with, and a message to an id that doesn't exist is refused instead of starting a new chat.
- A session's header no longer shows a model that belongs to a different runtime, like Codex with Opus. Changing a session's permission mode no longer changes the model it shows.
- If you call the DorkOS API directly: a message to a session id the server doesn't know now gets a "not found" answer. To start a new session with its first message, add `"create": true` to that message.
