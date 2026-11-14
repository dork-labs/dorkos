---
covers:
  - 'feat(browser): give each chat its own Agent browser tabs'
  - 'fix(browser): pause only the chat whose destination was refused'
  - 'fix(browser): teach agents to recover within their own tabs'
  - 'fix(browser): pause other chats while a person signs in'
---

### Added

- Browse from several chats at once in the Agent browser’s separate window. Each chat keeps its own tabs and pause controls.

### Fixed

- Pause a chat’s browser when it tries to open a blocked site. Other chats keep browsing.

### Security

- Pause other chats’ browser actions while you sign in. Their agents can still read their tabs.
