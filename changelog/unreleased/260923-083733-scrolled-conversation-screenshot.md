---
covers:
  - 'fix(client): a screenshot of a scrolled conversation shows its messages (DOR-2230)'
---

### Fixed

- A screenshot attached to a bug report from the browser now shows the conversation you were reading. If you had scrolled through a conversation, the screenshot showed an empty list, or one message under a large blank space, even though the messages were on your screen. This happened both when you captured the whole app and when you pointed at one part of it. The desktop app was not affected. When a report includes diagnostics, it now also shows each error's actual message instead of `{}` (DOR-2230).
- Bug reports now scrub private details from the diagnostics they carry. Folder paths that include your user name, secret-looking keys and passwords, and the query part of web addresses are removed before a report is sent, including from the crash details attached to a report (DOR-2230).
