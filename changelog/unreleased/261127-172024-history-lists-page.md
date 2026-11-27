---
covers:
  - 'feat(api): the inbox, the permission history and the audit record come a page at a time with a cursor (DOR-4982)'
---

### Changed

- Four lists in the DorkOS API now come a page at a time the same way every other list does: your inbox (`GET /api/notifications`), the permission history (`GET /api/permissions/history`), the audit record (`GET /api/audit`) and one account's history in it (`GET /api/audit/accounts/{accountId}/timeline`). Each stays newest first, and the app shows the same rows in the same order, with the same "Load more".
- If you call these lists from your own scripts: each answer now carries `nextCursor`. Send it back as `cursor` to get the next page; it is empty (`null`) on the last one. `limit` sets the page size, 1 to 200, and is 50 when left out. The inbox used to send 25 when you left `limit` out, and the inbox and the permission history took at most 100.
- The old ways to ask for the next page are gone: `before` on the inbox and the permission history, and `beforeSeq` with `nextBeforeSeq` on the audit record. The inbox refuses `before` with a clear message.
- The permission history's rows are now in `entries` instead of `items`.
- A cursor works only on the list that gave it, and an audit cursor only for the caller it was given to and until DorkOS restarts. Any other cursor is refused with a clear message instead of starting over.
- `dorkos permissions history` shows up to 200 changes and prints the `--cursor` that reads the next, older page.
