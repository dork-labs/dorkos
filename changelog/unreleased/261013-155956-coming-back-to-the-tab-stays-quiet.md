---
covers:
  - 'perf(client): coming back to the tab no longer re-reads everything (DOR-2896)'
---

### Changed

- Switching back to the DorkOS tab no longer asks the server again for every list and badge on screen, so coming back is quiet and fast. Live updates keep most of them current. If the tab was hidden for more than half a minute, DorkOS catches up once when you return. Things that change outside DorkOS, like your files, still refresh when you come back.
