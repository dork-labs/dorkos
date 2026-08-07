---
covers:
  - 'fix(server): report an MCP server sign-in state without waiting for a turn (DOR-985)'
  - 'fix(client): make the MCP Sign in button reachable and the row honest (DOR-985)'
  - 'fix(server): Test an MCP server the way a turn would, bearer included (DOR-985)'
  - 'fix(client): keep the MCP row honest when a sign-in expires (DOR-985)'
---

### Fixed

- The Sign in button for an MCP server now actually appears. Testing a server could tell you
  "Needs sign-in — click Sign in" when no such button existed, because the row only knew a
  server's state after the agent had taken a turn. A server that wants a sign-in now says so
  as soon as you open the list, and the button is there to click (DOR-985).
- A server whose sign-in has run out now says so and offers the button again, instead of
  sitting on a stale "Connected" from the last time the agent used it.
- Test now signs in the way the agent does, so testing a server you have already signed into
  reports what it really found instead of asking you to sign in all over again.
- The row stops saying "Needs sign-in" the moment you finish signing in, instead of waiting
  for the agent's next reply.
- Adding a server by web address checks it for you, so you find out it needs a sign-in without
  having to press Test first.
- A dropped connection while DorkOS is checking on your sign-in no longer ends the sign-in. It
  keeps checking for a few tries and says so, and a server that cannot be reached says that in
  plain words instead of showing a raw error.

### Changed

- A server DorkOS holds a sign-in for, but has not talked to yet, now reads "Signed in" rather
  than "Connected". "Connected" means the server actually answered.
