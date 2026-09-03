---
covers:
  - 'fix(client): retry belongs to the newest failure only (DOR-1677)'
---

### Fixed

- Scroll back to something that went wrong earlier in a chat and its Retry button is gone. That button always re-sent your newest message, not the one that failed, so pressing it on an old error sent the wrong thing without saying so. It now appears only on the newest message, where the two are the same. The error itself still shows, and you can always type again (DOR-1677)
- An old card about a sign-in that ran out keeps its sign-in button. Your login really is broken, whenever it broke, so fixing it there still works. Only the Retry beside it goes (DOR-1677)
