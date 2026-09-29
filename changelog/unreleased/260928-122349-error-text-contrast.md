---
covers:
  - 'fix(client): paint bare red warning text with the text-tuned red (DOR-2493)'
  - 'fix(client): red sheet rows read in the foreground colour while pressed (DOR-2493)'
---

### Fixed

- Red warning text is easier to read in dark mode. This covers the red number that shows a chat is nearly out of room, the message when a package fails to update, and red actions like Delete in the menu you open by pressing and holding a sidebar row on a phone. While you press one of those red actions, its words turn your normal text colour so they stay readable, and the icon stays as the warning sign (DOR-2493)
