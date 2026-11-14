---
covers:
  - 'fix(desktop): log every stream retry failure, rate-limited, and prove both address families reconnect (DOR-4294)'
---

### Fixed

- When the Mac app can't reach its own server, its log now says so every 30 seconds with a count of tries, and says when it reconnects. Before, it went quiet after the first try. (DOR-4294)
