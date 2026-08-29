---
covers:
  - 'fix(client): the working-since timer next to a busy agent no longer falls behind (DOR-1642)'
---

### Fixed

- The little "working on it · 12s" counter beside a busy agent now keeps true time. It used to slip a fraction of a second further behind with every second it counted, so on a long turn it read short (DOR-1642).
