---
covers:
  - 'fix(report-back): a spin-off chat with a very long error still reports back (DOR-3535)'
  - 'fix(report-back): a cut error says so right after it, and saves small (DOR-3535)'
---

### Fixed

- A spin-off chat that fails with a very long error now still tells the chat that started it. Before, the report could be too long to send, so nothing arrived. Now a long error, startup reason or question is cut to about 1,000 characters and ends with "(Details cut short.)" (DOR-3535).
