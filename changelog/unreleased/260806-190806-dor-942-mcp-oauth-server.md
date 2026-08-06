---
covers:
  - 'feat(server): OAuth sign-in for managed MCP servers — engine, capabilities, callback, injection (DOR-942)'
---

### Added

- You can now sign in to MCP servers that need OAuth (like Granola). Ask an agent to sign you
  in, follow the link it gives you, approve access in your browser, and come back — DorkOS
  keeps the sign-in token encrypted on your computer and hands it to the server for you, so the
  server's tools start working on the agent's next reply. It also refreshes the token quietly
  in the background before it expires, and if a server ever needs you to sign in again, testing
  it now says "needs sign-in" in plain words instead of a raw error (DOR-942).
