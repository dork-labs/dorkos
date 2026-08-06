---
covers:
  - "feat(client): sign in to OAuth MCP servers from the agent's server list (DOR-943)"
  - 'refactor(client): close review nits on MCP OAuth sign-in (DOR-943)'
---

### Added

- You can now sign in to an MCP server that needs OAuth right from the agent's server list,
  without asking an agent to do it for you. When a server needs a sign-in, its row shows
  "Needs sign-in" and a Sign in button. Click it, read what DorkOS will do with your sign-in,
  then open the link and approve access in your browser. The row then shows "Connected" and
  the server's tools work on the agent's next reply.

### Changed

- Each MCP server now shows its status in plain words (Connected, Needs sign-in, Failed, or
  Disabled), not a color dot with no label. Testing a server that needs a sign-in now says so
  and points you to the Sign in button, instead of showing a raw error (DOR-943).
