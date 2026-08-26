---
covers:
  - 'feat(memory,server,client): show when a memory backend stops answering (DOR-1560)'
---

### Added

- If you build or run a custom memory backend behind DorkOS's memory provider seam, DorkOS now tells you when it stops using yours — instead of quietly falling back to its own local notes and only saying so once in the server log. A banner in the app names the backend and says why, and `GET /api/system/memory` reports the same thing for anyone scripting against it. This only matters if you've registered a backend of your own; a stock DorkOS install always uses its built-in memory (DOR-1560)
- When that fallback already has notes on it and DorkOS injects them into a turn, the affected agent is now told those notes come from a different local store, not its usual memory, so it does not assume anything missing was never saved. This does not cover every fallback yet — the more common case, an agent's very first turn on the fallback, stays silent for now (DOR-1560)
