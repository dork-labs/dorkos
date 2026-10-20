---
covers:
  - 'feat: add an approvals passkey at this computer, list it and remove it (B4c)'
  - 'fix(server): a new approvals passkey finishes without a session, from the return page only (B4c)'
  - 'fix: approvals passkeys follow the link, return to the address DorkOS listens on, and can clear a damaged file (B4c review)'
  - 'fix(server): a passkey finishing as the computer unlinks never lands, and an unreadable passkeys file is never removed (B4c re-review)'
---

### Added

- You can add a passkey for approving from the web. In Settings, under Chat from the web, a linked computer now lists its approval passkeys, adds one, and removes one. Adding or removing one needs your password, and works only in the app on the computer DorkOS runs on, never from Wi-Fi or another device. Each passkey is made for this one computer, separate from the passkey you sign in to DorkOS with. This sits behind the same switch as the rest of using DorkOS from anywhere, which is off by default, and approving from the web itself isn't turned on yet.
