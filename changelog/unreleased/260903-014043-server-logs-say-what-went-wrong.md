---
covers:
  - 'fix(server): the log line now says what went wrong (DOR-802)'
  - 'fix(server): bound the log line, and never throw out of the logger (DOR-802 review folds)'
---

### Fixed

- Server log files now record what actually went wrong. When something failed, the saved line kept only the headline ("Failed to load workspaces") and threw away the reason, so the log often could not explain the failure it was written for. Every line now carries the error's message, its stack, and the chain of underlying causes (DOR-802)
