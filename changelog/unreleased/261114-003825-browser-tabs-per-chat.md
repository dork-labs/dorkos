---
covers:
  - 'feat(browser): give each chat its own Agent browser tabs'
  - 'fix(browser): pause only the chat whose destination was refused'
  - 'fix(browser): teach agents to recover within their own tabs'
  - 'fix(browser): pause other chats while a person signs in'
  - 'fix(browser): keep saved sign-ins visible while paused'
  - 'fix(browser): stack saved sign-ins on small screens'
  - 'fix(browser): limit chat tabs and isolate sign-in popups'
  - 'fix(browser): scope chat tab inventory to direct chats'
  - 'fix(dev): isolate browser panel showcase chat caches'
  - 'fix(browser): admit sign-in popups only after a person takes the tab'
  - 'fix(browser): let panel buttons grow with wrapped labels'
---

### Added

- Browse from several chats at once in the Agent browser’s separate window. Each chat keeps one tab and its own pause controls.

### Fixed

- Pause a chat’s browser when it tries to open a blocked site. Other chats keep browsing.
- Keep Saved sign-ins visible while another chat waits for you to sign in.
- Stack Saved sign-ins on small screens.
- Keep long chat and agent names readable on browser buttons.
- Wait when six chats have browser tabs open. Choose an idle chat’s tab to close.

### Security

- Pause other chats’ browser actions while you sign in. Their agents can still read their tabs.
- Allow sign-in popups after you show the held tab, one at a time. Agents can’t read or use them.
