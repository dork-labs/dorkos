---
covers:
  - 'fix(sessions): an agent can start or continue a chat only as itself, over the API too (DOR-3644)'
  - 'fix(sessions): every turn of a recorded chat runs as its agent, and queued messages meet the place rule (DOR-3644)'
---

### Fixed

- An agent can no longer start a chat in another agent's folder, or post into another agent's chat, through DorkOS's API. It already couldn't from inside a chat. To reach another agent, it sends that agent a message. Once DorkOS has an owner, a program DorkOS can't name can't start work in any agent's folder or chat. That includes scripts and other devices using an API key: they now get an error there, and should use the app or an agent's own token. You can still start a chat anywhere in the app, as before.
