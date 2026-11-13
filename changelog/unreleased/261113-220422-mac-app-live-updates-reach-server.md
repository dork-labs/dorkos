---
covers:
  - 'fix(desktop): the Mac app reaches its own server on the address it is listening on (DOR-4294)'
---

### Fixed

- In the Mac app, the menu bar count of busy agents and desktop notifications could stop working after launch, with no warning. On some Macs the app looked for its own server at the wrong address. It now uses the address the server is really on, so both keep working. (DOR-4294)
- Allow, Deny and Reply on a desktop notification work on those Macs too, instead of quietly doing nothing. (DOR-4294)
- Settings now shows the right address for connecting other tools to DorkOS when the server is set to listen somewhere other than `localhost`. (DOR-4294)
