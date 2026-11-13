---
covers:
  - 'fix(server): the Agent browser open errors use its name and say what to do (DOR-3219)'
  - 'fix(server): a browser profile is sent to its own window, in the panel’s words (DOR-3219)'
---

### Fixed

- When the Agent browser can't open, the message now uses its name and says what to do: choose where it opens (in DorkOS or in its own window), or use the desktop app to open it in DorkOS. If you try to open a browser profile in DorkOS, the message says to open it in its own window. (DOR-3219)
