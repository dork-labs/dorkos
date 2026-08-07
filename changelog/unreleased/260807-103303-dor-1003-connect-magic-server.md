---
covers:
  - 'feat(server): learn an MCP server needs a sign-in the moment it is added (DOR-1003)'
  - 'feat(server): report how many tools a finished MCP sign-in unlocked (DOR-1003)'
  - 'feat(server): name the server on the MCP sign-in return page (DOR-1003)'
---

### Added

- Add a server that needs a sign-in and DorkOS says so immediately. It checks the address as
  it saves it, so the "Sign in" button is there the first time you look — you no longer have
  to press Test to find out (DOR-1003).
- When you finish signing in, DorkOS tells you how many tools you just unlocked — "Connected —
  12 tools." — instead of only saying it worked (DOR-1003).
- The page you land on after signing in now names the server you signed in to, says what
  happens next in plain words, and gives you a link back to DorkOS (DOR-1003).

### Fixed

- "You're already signed in" is now checked, not assumed. DorkOS asks the server whether the
  sign-in it saved still works; if the server says no, it clears it and gives you a fresh
  sign-in link instead of telling you everything is fine and failing later (DOR-1003).
