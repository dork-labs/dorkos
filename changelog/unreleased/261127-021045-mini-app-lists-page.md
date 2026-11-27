---
covers:
  - 'feat(api): the mini app lists come a page at a time (DOR-4982)'
---

### Changed

- Four lists about mini apps in the DorkOS API now come a page at a time: your installed mini apps, the ones waiting for your first yes, approvals left behind by a mini app that is gone, and the plugins whose mini apps wait to be allowed together. The app reads every page, so Settings and your inbox look the same as before.
- If you call these lists from your own scripts: `GET /api/extensions` used to answer a bare list. It now answers `{ extensions: [...], nextCursor }`. The other three keep their field (`approvals` or `sets`) and add `nextCursor`. Send `nextCursor` back as `cursor` to get the next page; it is empty (`null`) on the last one. `limit` sets the page size, 1 to 200, and is 50 when left out. A cursor DorkOS did not give, or one given to someone else, is refused with a clear message instead of starting over.
- Over the API, mini apps waiting for a yes now come newest first (they were oldest first). Installed mini apps, leftover approvals and waiting plugins now come in reverse name order. The app still shows them as before.
- In the API description these lists are now named `extensions.list`, `extensions.listPendingApprovals`, `extensions.listStaleApprovals` and `extensions.listApprovalSets`.
