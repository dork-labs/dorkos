---
covers:
  - "fix(client): no more false 'can't reach its server' flash on refresh"
---

### Fixed

- Refreshing the page no longer opens on "DorkOS can't reach its server" for a few seconds when the server is running fine. DorkOS was remembering an old connection hiccup and treating it as proof the server was down right now. It only says the server is unreachable when this visit's own attempt fails.
