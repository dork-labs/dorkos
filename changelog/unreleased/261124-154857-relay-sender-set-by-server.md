---
covers:
  - 'fix(relay): the sender of a relay message is set by the server (DOR-5151)'
---

### Changed

- DorkOS now decides who a Relay message sent through its HTTP API is from. Your own message from the app is still sent as you. An agent's message is sent from that agent, and any other program's from `relay.external.http`. Only you can send from a person's address; the app asks for your password once if it needs to (DOR-5151).
- A Relay message from an agent or a program now runs like any other outside message: it can't choose the folder, agent or approval mode of the turn it starts, and it carries any limits its agent's own work is under (DOR-5151).
