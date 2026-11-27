---
covers:
  - 'feat(api): the chat connection lists come a page at a time (DOR-4982)'
  - 'fix(api): the installed mini app list pages in the order it always came in (DOR-4982)'
  - "fix(api): paged connection lists read back in the app's old order; e2e mock takes the page shape (DOR-4982)"
---

### Changed

- Three lists about chat connections in the DorkOS API now come a page at a time: your connections, the kinds you can connect, and the routes from a chat to an agent. The Connections page reads every page, so what you see there is unchanged.
- If you call these lists from your own scripts: `GET /api/relay/adapters` and `GET /api/relay/adapters/catalog` used to answer a bare list. They now answer `{ adapters: [...], nextCursor }` and `{ entries: [...], nextCursor }`. `GET /api/relay/bindings` keeps `bindings` and adds `nextCursor`. Send `nextCursor` back as `cursor` to get the next page; it is empty (`null`) on the last one. `limit` sets the page size, 1 to 200, and is 50 when left out.
- Over the API, chat routes now come newest first. Connections keep the order they are saved in, and the kinds keep the order the setup list shows. The Connections page still lists chat routes oldest first. All three are now described in the API reference.
