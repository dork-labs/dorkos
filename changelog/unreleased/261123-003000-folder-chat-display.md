---
covers:
  - "fix(session): a chat started in an agent's folder from the command line shows its agent everywhere (DOR-5038, slice C)"
---

### Fixed

- A chat started with only an agent's folder, from the command line for example, now shows that agent's name when another chat reads it. Its held messages count when the agent is paused, and the chats it starts count as the agent's open work (DOR-5038).
