---
covers:
  - 'fix(server): keep managed MCP server headers off the codex exec command line (DOR-993)'
---

### Fixed

- Fixed a leak where the access token for a connected tool server showed up on the command line of the Codex program DorkOS starts, which meant any other program on your computer could read it. The token now travels out of sight, and your agents reach those servers exactly as before (DOR-993)
