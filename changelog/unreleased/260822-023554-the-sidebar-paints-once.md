---
covers:
  - 'feat(client): the sidebar paints once — a boot gate, a skeleton, and one reveal (DOR-1372, DOR-1143)'
---

### Changed

- The sidebar no longer builds itself in front of you when the app opens. It waits until it knows
  what to draw, showing a quiet outline of the panel in the meantime, and then appears once. Your
  channels, direct messages and agents all arrive together instead of popping in one group at a
  time (DOR-1372)

### Fixed

- Your agents keep their faces and names from the first moment you see them. They used to appear
  with a placeholder emoji and colour that changed a second later — every agent at once (DOR-1143)
- The panel asks the server for the same thing once instead of twice, so the app has less to do
  while it starts. DorkOS now watches your 24 most recent conversations for work that needs you,
  up from 10 — so a session that has been waiting a while is less likely to be missed (DOR-1372)
- Opening the app on a channel no longer scrolls the panel on its own. The open conversation is
  simply already in view (DOR-1372)
