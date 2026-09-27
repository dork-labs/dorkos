---
covers:
  - 'perf(connectors): keep each service app list instead of fetching it on every page and search (DOR-2463)'
---

### Changed

- The Connections list pages and searches much faster. DorkOS now keeps each connection service's list of apps for a day instead of asking for the whole list again on every page and every search, and it drops that copy as soon as you change or remove the service's key (DOR-2463)
