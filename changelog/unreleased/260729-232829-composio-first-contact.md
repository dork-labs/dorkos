---
covers:
  - 'fix(connectors): survive first contact with the real Composio API — verified shapes, loud failures (DOR-703 follow-up)'
---

### Fixed

- Connecting Composio now works against their real API: the connect flow, service list, and account list all speak Composio's current shapes (verified against their published reference)
- A connector that can't reach its service now says so. A failing provider shows up as a warning on the Connections page instead of a silently empty service grid, and the message includes what the service itself said — for example that your key isn't a project API key
- A provider only shows as ready after DorkOS confirms the key actually works with one quick check — a wrong key now fails loudly on the provider card at save time instead of looking connected
