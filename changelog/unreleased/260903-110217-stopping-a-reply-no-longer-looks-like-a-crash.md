---
covers:
  - 'fix(server): an escalated Stop on the pump settles as the stop it was (DOR-1302)'
---

### Fixed

- Fixed a bug where pressing Stop could look like the agent had crashed. When an agent does not answer a stop quickly enough, DorkOS ends it — and that ending was reported as a failure, with a red error on the reply you had just stopped. It now shows as what it was: a reply you stopped. This includes stopping a message the moment you send it, while the agent is still starting up, which used to show a raw error (DOR-1302)
- Fixed a bug where stopping two replies in a row made the third message refuse to send, with the message "This chat's agent keeps stopping". That count is meant to catch an agent that cannot stay running, and a stop you pressed yourself no longer counts against it (DOR-1302)
