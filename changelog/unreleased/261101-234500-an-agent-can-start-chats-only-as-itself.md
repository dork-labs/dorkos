---
covers:
  - 'fix(sessions): an agent can start or continue a chat only as itself, over the API too (DOR-3644)'
---

### Fixed

- An agent can no longer start a chat in another agent's folder, or post into another agent's chat, through DorkOS's API. It already couldn't from inside a chat. To reach another agent, it sends that agent a message. Once DorkOS has an owner, a program DorkOS can't name can't start work in any agent's folder. You can still start a chat anywhere, as before.
