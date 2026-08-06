---
covers:
  - 'feat(server): OAuth sign-in for managed MCP servers — engine, capabilities, callback, injection (DOR-942)'
---

### Added

- You can now sign in to MCP servers that need OAuth, like Granola. Ask an agent to sign you
  in, open the link it gives you, and approve access in your browser. DorkOS keeps the sign-in
  token encrypted on your computer and sends it to the server for you, so the server's tools
  start working on the agent's next reply. DorkOS refreshes the token quietly before it runs
  out, and it remembers your sign-in if you restart. If a server needs you to sign in again,
  checking it now says "needs sign-in" in plain words instead of a raw error. One thing to
  know for now: if a server signs you out while you are working, DorkOS may not notice until
  the next time you check that server, so sign in again to fix it (DOR-942).
