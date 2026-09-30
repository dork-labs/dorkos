---
covers:
  - 'feat(cloud): send a community move in parts when the server offers them (DOR-2297)'
  - 'fix(cloud): say plainly that a move must start again after DorkOS restarted (DOR-2297)'
---

### Added

- Moving a community into a hosted community now sends a large export in pieces when the new community's server supports it. If the connection drops, sending again picks up with the pieces that are still missing instead of starting over, and the progress bar keeps counting from where it was. Servers that take the file in one piece work as before. If DorkOS restarts during a move, the move now says plainly that it has to start again, and a move whose upload time ran out says that instead of a general error. (DOR-2297)
