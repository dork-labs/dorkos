---
covers:
  - 'feat(feedback): capture the context triage actually needs (DOR-1960)'
  - 'fix(feedback): allowlist the route query string (DOR-1960)'
---

### Changed

- Bug reports now say which page you were on more precisely — not just `/session` but which conversation. The address is filtered first: the folder you are working in and anything you typed to an agent are stripped out before it is sent, and you can read the exact address in the preview before you send (DOR-1960)
- Bug reports can also carry your window size, browser, and light/dark setting, so a layout problem can be reproduced without us asking what you were looking at. These ride under the same Diagnostics switch as before — turn it off and none of them are sent — and the preview lists every one (DOR-1960)
