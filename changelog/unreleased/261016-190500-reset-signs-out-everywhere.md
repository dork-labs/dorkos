---
covers:
  - 'feat(server): reset-password signs out everywhere, sign-ins last 30 days, the MCP token loads on first use (DOR-2968 part 1)'
---

### Changed

- `dorkos auth reset-password` now signs out every browser and device, and says what it can't cut off yet: a window already open, live streams, and API keys (DOR-2968).
- A sign-in now lasts 30 days, and each day you use DorkOS pushes that back (DOR-2968).
- Turning off "Ask for a password on this computer too" no longer needs a restart before MCP apps on this computer work (DOR-2968).
- Settings says the local MCP token works only for apps on this computer. Other devices need a personal API key (DOR-2968).
