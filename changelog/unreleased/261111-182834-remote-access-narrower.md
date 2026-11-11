---
covers:
  - 'fix(server): remote access serves the app and little else to other devices (DOR-3650)'
  - 'fix(server): /mcp and /a2a refuse a key in the address (DOR-3650)'
---

### Fixed

- Remote Access is tighter for what isn't the app. From another device, `/mcp` takes only a personal API key, never a sign-in from the app, and Settings now says so under the MCP address. The key goes in the request's header: a key written into the address itself is refused, since addresses end up in logs. Agents can no longer read the tunnel's public address. DorkOS won't open a tunnel to any port but its own. Webhooks still work over the tunnel: each one is checked against its signature first, and a refused one gets one plain answer. The app on your phone works as before. (DOR-3650)
