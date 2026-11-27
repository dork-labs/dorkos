---
covers:
  - 'feat(api): the chat list and the recent chats come a page at a time (DOR-4982)'
  - 'fix(api): later pages of the recent chats leave out exactly what page one kept (DOR-4982)'
---

### Changed

- Two chat lists in the DorkOS API now come a page at a time: the chats in a folder (`GET /api/sessions`) and the recent chats across every agent (`GET /api/sessions/recent`). Both stay in the same order as before, the chat with the latest activity first. The app shows the same chats in the same order as before.
- If you call these lists from your own scripts: each answer now carries `nextCursor`. Send it back as `cursor` to get the next page; it is empty (`null`) on the last one. `limit` sets the page size, 1 to 200, and is 50 when left out. The folder list used to send up to 200 chats when you left `limit` out, and the recent list 10, with at most 50.
- A chat that gets a new message while you read the pages can show up twice or be skipped, because the order follows activity.
- A cursor works only for the caller it was given to. A cursor from someone else, from another list, or from before DorkOS restarted is refused with a clear message instead of starting over.
- With `touchedSince`, the recent list's first page still holds every chat you used since that time, and later pages leave those chats out so none shows up twice. A chat you open while reading the pages still shows up. Ask every page with the same `touchedSince`: a different one, or none, is refused.
