---
covers:
  - 'feat(links): a /r/ link opens a chat, room, message or agent (DOR-5046)'
---

### Added

- A link of the form `/r/dork:chat:<id>` now opens that chat in DorkOS, and the same works for a room, a single message and an agent. Paste one into a room, a to-do or a ticket and it opens the right screen; in the desktop app, `dorkos://r/…` does the same. A link to something you can't see shows the usual "Page not found" page, the same as a link to something that isn't there (DOR-5046).
