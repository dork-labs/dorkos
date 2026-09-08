---
covers:
  - 'fix(connections): protect raw MCP URLs and resume pending checks'
---

### Changed

- Pending raw MCP connection checks now survive a DorkOS restart.

### Security

- Keep raw MCP server URLs out of shared configuration snapshots, where embedded credentials could be exposed.
