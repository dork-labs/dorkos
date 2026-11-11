---
covers:
  - 'fix(browser): label installed Chrome with native profile prefs (DOR-4178)'
  - 'fix(browser): use native Chrome identity and detach person handoffs (DOR-4178)'
  - 'fix(desktop): the public Chrome proof loads as an ES module, so its CI step can run (DOR-4178)'
---

### Fixed

- Keep the agent disconnected while you finish a browser handoff, including password entry. Continue reconnects it; Stop task leaves it disconnected (DOR-4178).
- Use installed Chrome for separate browser windows when available. In the Mac app’s panel, identify the browser by its actual Chrome engine version (DOR-4178).

- Give agent Chrome windows an orange profile colour, the agent’s name and a distinct avatar (DOR-4178).
