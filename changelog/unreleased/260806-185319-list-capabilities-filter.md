---
covers:
  - 'feat(server): list_capabilities filters, paginates, and compacts by default (DOR-940)'
---

### Changed

- `list_capabilities` now returns a short, filterable list instead of the whole catalog at once. A plain call gives you one compact line per capability (id, title, tier, and a summary), so discovering what a DorkOS can do no longer floods an agent's context. Narrow it with `domain` (e.g. `mcp`) or a `query`, ask for `detail: "full"` to see the input and output schemas, and page with `limit` and `cursor`. When a page leaves some out, it says how many and how to see the rest (DOR-940).
