---
covers:
  - 'perf(client): background checks follow live updates instead of polling (DOR-2909)'
---

### Changed

- DorkOS asks the server far less often while you just look at the screen. The relay activity list, agent health and your community spaces follow live updates instead of re-asking every few seconds. Most changes show right away. A few can take up to a minute, like a chat app quietly losing its connection.
