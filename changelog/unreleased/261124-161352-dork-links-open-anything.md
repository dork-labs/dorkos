---
covers:
  - 'feat(links): a /r/ link opens a chat, room, message or agent (DOR-5046)'
  - 'fix(links): a /r/ link to a new chat still opens after a restart (DOR-5046)'
---

### Added

- A link like `/r/dork:chat:<id>` now opens that chat in DorkOS. Links to a room, a single message and an agent work the same way, whether you open one in DorkOS or click one in a room or a chat. Put your DorkOS address in front of it and the full link works from anywhere, and a `dorkos://r/…` link opens it in the desktop app. A link to a chat copied in its first few seconds still opens after DorkOS restarts. A link to something you can't see shows "Page not found", the same as a link to something that isn't there (DOR-5046).
