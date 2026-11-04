---
covers:
  - 'fix(server): agents get accurate guidance about outside text'
---

### Fixed

- Agents now get accurate guidance about text from outside your team. They were told that reading it always made a person approve their next send, but DorkOS mainly tracks that for messages sent over your Wi-Fi by someone other than you. Agents now know to treat chat apps, mail and web pages as untrusted and to ask before they send.
