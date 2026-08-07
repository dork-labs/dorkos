---
covers:
  - 'fix(server): report an MCP server sign-in state without waiting for a turn (DOR-985)'
  - 'fix(client): make the MCP Sign in button reachable and the row honest (DOR-985)'
---

### Fixed

- The Sign in button for an MCP server now actually appears. Testing a server could tell you
  "Needs sign-in — click Sign in" when no such button existed, because the row only knew a
  server's state after the agent had taken a turn. A server that wants a sign-in now says so
  as soon as you open the list, and the button is there to click (DOR-985).
- The row flips to "Connected" as soon as you finish signing in, instead of staying on
  "Needs sign-in" until the agent's next reply.
- Adding a server by web address checks it for you, so you find out it needs a sign-in without
  having to press Test first.
- A dropped connection while DorkOS is checking on your sign-in no longer ends the sign-in. It
  keeps checking for a few tries and says so, and a server that cannot be reached says that in
  plain words instead of showing a raw error.
