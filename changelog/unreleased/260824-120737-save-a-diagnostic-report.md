---
covers:
  - 'feat(desktop,server): one-click diagnostic report and first-contact log markers'
---

### Added

- When the desktop app misbehaves, Help → Save Diagnostic Report now gathers everything we need to help you into a single file on your Desktop: the app's logs, your version numbers, where the app is installed, and what its last update did. Your saved keys and passwords are replaced with [redacted]. The logs go in as-is, so glance through them if you're unsure about anything in there. The same item is in the DorkOS menu on your menu bar, which still works when the window itself won't open. The logs now also record the moment DorkOS first reaches its own server, so "it opened but nothing loaded" is a question the file can actually answer (DOR-1456)
