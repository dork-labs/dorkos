---
covers:
  - 'fix(server): an MCP or OpenRouter sign-in finishes from the browser redirect instead of asking you to sign in'
---

### Fixed

- Signing an agent in to an MCP server (or signing in to OpenRouter) now finishes when the sign-in page sends you back. Before, DorkOS answered "Unauthorized" because the browser said it came from the other site.
