---
covers:
  - 'fix(relay): the sender of a relay message is set by the server (DOR-5151)'
  - 'fix(relay): a relay message from someone other than the person sets no reply format (DOR-5151)'
---

### Changed

- DorkOS now decides who a Relay message sent through its HTTP API is from. Your own message from the app is still sent as you; the app asks for your password once if it needs to. An agent's message is sent from that agent, and any other program's from `relay.external.http` (DOR-5151).
- A script that sent from a `relay.human.…` address is now refused; send from another address, such as `relay.external.my-script`. Its `cwd`, `forAgent`, approval mode and reply-format fields are now ignored (DOR-5151).
- A Relay message from an agent or a program now runs like any other outside message, and it carries any limits its agent's own work is under (DOR-5151).
