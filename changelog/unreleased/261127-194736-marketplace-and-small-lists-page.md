---
covers:
  - "feat(api): the marketplace lists, Shapes, an agent's MCP servers and the agent roster come a page at a time (DOR-4982)"
  - 'fix(api): a page cursor stays a fixed size however long a folder or filter is (DOR-4982)'
  - 'feat(mesh): the mesh_list agent tool pages like GET /api/mesh/agents (DOR-5480)'
  - "fix(mesh): keep the paused-agents page's keysetPage import and use AgentToolDeps after the rebase (DOR-5480)"
---

### Changed

- Eight lists in the DorkOS API now come a page at a time: the marketplace sources (`GET /api/marketplace/sources`), the packages to browse (`/packages`), what is installed (`/installed`), the packages held back (`/held-back`) and the dev links (`/dev-links`); the installed Shapes (`GET /api/shapes`); one agent's MCP servers (`GET /api/agents/{agentId}/mcp-servers`); and the agent roster (`GET /api/mesh/agents`). The app reads every page and shows each list in the same order as before.
- If you call these lists from your own scripts: each answer now carries `nextCursor`. Send it back as `cursor` to get the next page; it is `null` on the last one. `limit` sets the page size, 1 to 200, and is 50 when left out. An agent's MCP servers used to come back as a bare list; they now come in `servers`.
- The agent tools that read the same lists page too: `marketplace_list_marketplaces`, `marketplace_list_installed` and `mcp_list_server` take `cursor` and `limit` and return `nextCursor`. `dorkos marketplace list|installed|refresh|held-back|keep-files`, `dorkos agent list` and `dorkos permissions` read every page for you.
- Something added or removed while you read the pages can show up twice or be skipped. The roster goes newest registered first, so a newly registered agent is never repeated.
- A cursor from another list is refused with a clear message instead of starting over. For the installed packages, the held-back packages and the roster, a cursor also works only for the caller it was given to, since an agent reads those without a person's folders.
