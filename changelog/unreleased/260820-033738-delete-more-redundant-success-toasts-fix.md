---
covers:
  - 'fix(client): delete more redundant success toasts; fix cancel-run double-toast (DOR-1379)'
---

### Fixed

- A few more success messages that popped up for things you could already see are gone: saving an extension setting, saving or clearing a secret, and turning an extension on or off all show the change right on the control now, with no extra message on top. Stopping a scheduled task run that fails to stop now shows one clear message instead of a chance of two.
