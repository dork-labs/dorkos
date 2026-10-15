---
covers:
  - 'feat(remote-access): open DorkOS from another device on your Wi-Fi (DOR-2930)'
  - 'fix(remote-access): review fixes for Wi-Fi access (DOR-2930)'
---

### Added

- On a Mac, open DorkOS on your phone or tablet over your home or office Wi-Fi, with no tunnel. Turn on **Let devices on my Wi-Fi in** in Settings → Remote access, then scan the QR code it shows. It works in the Mac desktop app too.
- The switch takes effect right away, with no restart, and turning it off shuts the door at once.
- It needs a login. If login is off, DorkOS walks you through creating your account first, and turning login off later turns Wi-Fi access off too.
- Only devices on the same network as your computer get in.
- The connection between your devices is not encrypted yet, so use it on a network you trust.
