---
covers:
  - 'feat(server): warn when a server''s arguments look like a secret, and clearer "Confirm it''s you" lines for MCP servers (DOR-3826)'
---

### Changed

- When you add an MCP server, DorkOS warns you if its arguments look like they hold a secret, so you can use a hidden field instead. The warning never stops you adding it (DOR-3826).
- "Confirm it's you" for an MCP server now opens with what will happen, shows warnings in warning color, and names each setting and header once. When an agent calls itself something other than its real name, you see both (DOR-3826).

### Security

- On Claude Code, agents' file tools are refused the file that stores the MCP servers you added for every agent. This stops a slip, not a program set on reading it (DOR-3826).
- A server's address must now start with `https://` or `http://`. A secret written as `--token:value`, `"--token value"` or JSON in a server's arguments is now hidden wherever it's shown (DOR-3826).
