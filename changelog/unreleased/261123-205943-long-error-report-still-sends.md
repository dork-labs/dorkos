---
covers:
  - 'fix(report-back): a spin-off chat with a very long error still reports back (DOR-3535)'
---

### Fixed

- A spin-off chat that fails with a very long error now still tells the chat that started it. Before, the report could be too long to send, so nothing arrived. Now a long error, startup reason or question is cut to about 1,000 characters, with a note that it was shortened (DOR-3535).
