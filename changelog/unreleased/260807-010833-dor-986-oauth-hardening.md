---
covers:
  - 'fix(server): harden the managed-MCP OAuth engine after adversarial review (DOR-986)'
  - 'docs(changelog): say what the managed-MCP OAuth fixes mean for people (DOR-986)'
  - 'fix(server): serialize the MCP callback exchange against a background refresh (DOR-986)'
  - 'docs(changelog): fold the MCP callback fragment into the DOR-986 entry (DOR-986)'
---

### Fixed

- You can sign in again after taking DorkOS's access away. If you removed DorkOS from an MCP
  server's own website, the Sign in button used to fail every time from then on, with no way
  back except deleting the server. It now hands you a fresh sign-in link (DOR-986).
- MCP servers no longer stop working about an hour after you sign in. When DorkOS renewed
  your access in the background it forgot to say which server the renewal was for, so strict
  servers either refused it or handed back a pass that did not open anything (DOR-986).
- Removing an MCP server now removes the sign-in DorkOS was keeping for it. The server used
  to vanish from your list while the saved sign-in stayed on your computer, quietly renewing
  itself. Deleting an agent clears its sign-ins too (DOR-986).
- Pointing an MCP server at a new address now asks you to sign in to that address. Before,
  DorkOS could send the old server's sign-in to the new one (DOR-986).
- Reloading the "Signed in" page no longer turns a finished sign-in into a failed one
  (DOR-986).
- Losing your connection for a moment no longer signs you out of every MCP server until you
  restart DorkOS. DorkOS retries a few times, and only gives up when the server itself says
  the sign-in is no longer good (DOR-986).
