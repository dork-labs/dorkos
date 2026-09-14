---
covers:
  - 'fix(client): keep the route error screen from crashing on a non-Error throw (DOR-2032)'
---

### Fixed

- When part of DorkOS fails to load, the "Something went wrong" screen now always shows, with its Try again and Back to home buttons. Before, some unusual failures could crash that screen too, and you saw nothing useful (DOR-2032)
