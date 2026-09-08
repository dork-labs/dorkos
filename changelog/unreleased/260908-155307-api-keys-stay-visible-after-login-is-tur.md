---
covers:
  - 'fix(client,e2e): API keys stay visible after login is turned off (DOR-1885)'
---

### Fixed

- Your API keys stay listed in Settings → Access after you turn "Require login" back off. Turning login off never revoked those keys — they kept working for MCP clients and scripts — but the list disappeared, so there was no way to see them or revoke one.
