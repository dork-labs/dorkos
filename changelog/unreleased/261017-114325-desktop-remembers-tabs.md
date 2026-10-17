---
covers:
  - 'feat(desktop): remember open tabs across quits, restarts and crashes (DOR-2986)'
  - 'fix(desktop): harden tab restore after review (DOR-2986)'
---

### Added

- The desktop app now keeps your tabs when it closes. An update, a crash or a recovery restart brings every tab back, in order, with the one you were on in front and each tab's own Back history. After a normal quit they come back too, unless you choose Start fresh in Settings → Preferences → When DorkOS opens (DOR-2986)
- Bring back a tab you closed with Cmd+Shift+T, or pick one from Recently closed in a tab's right-click menu. It holds your last 25 closed tabs, across quits (DOR-2986)
- Pinned tabs always come back. An unpinned tab you haven't looked at for a week is not reopened at launch; it waits in Recently closed instead (DOR-2986)
- A tab whose chat was deleted, or whose room you left, is quietly moved to Recently closed when the app opens, instead of showing an error (DOR-2986)
