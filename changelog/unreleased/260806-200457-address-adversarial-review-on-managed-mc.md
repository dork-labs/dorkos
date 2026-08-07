---
covers:
  - 'fix(server): address adversarial review on managed-MCP OAuth (DOR-942)'
---

### Fixed

- Signing in to an MCP server now survives restarting DorkOS. Before, DorkOS treated a
  sign-in it loaded from disk as if it had just been granted, so an old one looked fresh and
  the server rejected every request until you signed in again (DOR-942).
- A failed sign-in now says "Sign-in failed. Please try again." in the browser instead of
  showing the raw error from the server (DOR-942).
