---
covers:
  - 'fix(runtimes): OpenCode restarts its background process when a project gains its own plugins during a chat (DOR-4412)'
---

### Fixed

- OpenCode restarts its background process when a project gains its own plugins during a chat. Other OpenCode chats wait until it is back, and the Activity feed says which folder it was. A reply that was still running in another chat stops, and you can send it again (DOR-4412).
