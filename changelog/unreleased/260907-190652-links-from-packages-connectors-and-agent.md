---
covers:
  - 'fix(client): links from packages, connectors and agents clear the same safety check as every other link (DOR-924)'
---

### Fixed

- Links from packages, connectors and agents clear the same safety check as every other link. A package's homepage, a sign-in link from a connector or an MCP server, an add-on's setup button and a "Learn more" link all used to be handed straight to your browser. Now they go through the same check DorkOS runs on every other link, and one it won't open says so instead of doing nothing.
