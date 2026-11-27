---
covers:
  - 'feat(api): paused agents, hidden folders, push browsers and trusted sources come a page at a time (DOR-4982)'
  - 'fix(api): the hidden-folder list says it can repeat or miss a folder; bad-cursor tests (DOR-4982)'
---

### Changed

- Four more lists in the DorkOS API now come a page at a time: the agents paused right now (`GET /api/agents/pauses`), the folders hidden from agent discovery (`GET /api/mesh/denied`), the browsers DorkOS may send notifications to (`GET /api/push/subscriptions`), and the code sources you trust (`GET /api/extensions/trusted-sources`). Each keeps the order it always had. The app reads every page, so these lists look the same as before.
- If you call these lists from your own scripts: each answer keeps its list field (`pauses`, `denied`, `subscriptions` or `sources`) and adds `nextCursor`. Send it back as `cursor` to get the next page; it is empty (`null`) on the last one. `limit` sets the page size, 1 to 200, and is 50 when left out. A cursor this list did not give is refused with a clear message instead of starting over.
- Agents get the same pages: the `list_paused_agents` tool now answers a page at a time and says so, so an agent reads on until `nextCursor` is empty.
- A pause, a hidden folder, a trusted source or a browser added or removed while you read the pages can show up twice or be skipped.
- In the API description the trusted sources list is now named `extensions.listTrustedSources`.
