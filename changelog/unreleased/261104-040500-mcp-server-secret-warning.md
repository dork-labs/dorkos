---
covers:
  - 'feat(server): warn when a server''s arguments look like a secret, and clearer "Confirm it''s you" lines for MCP servers (DOR-3826)'
---

### Changed

- When you add an MCP server, DorkOS warns you if its arguments look like they hold a secret, so you can use an Only you field instead. The warning never stops you adding it (DOR-3826).
- "Confirm it's you" for an MCP server now opens with what will happen, shows warnings in warning color, and names each setting and header once. When an agent calls itself something other than its real name, you see both (DOR-3826).

### Security

- Agents can no longer read the file that stores the MCP servers you added for every agent. A server's address must now start with `https://` or `http://` (DOR-3826).
