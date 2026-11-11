---
covers:
  - 'fix(browser): use native Chrome identity and detach person handoffs (DOR-4178)'
---

### Fixed

- Keep the agent disconnected while you finish a browser handoff, including password entry. Continue reconnects it; Stop task leaves it disconnected (DOR-4178).
- Use installed Chrome for separate browser windows when available. In the Mac app’s panel, identify the browser by its actual Chrome engine version (DOR-4178).
