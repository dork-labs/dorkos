---
covers:
  - 'feat(connections): show each app’s real logo and one line about it (DOR-2464)'
  - 'feat(connections): find an app by its one line when searching (DOR-2464)'
  - 'fix(connections): brands’ own logos, logos for every connected app, and a monthly refresh (DOR-2464)'
  - 'fix(connections): no logo request for apps the catalog says have none, background refresh (DOR-2464)'
  - 'fix(connectors): keep hosted catalog search reaching Composio (DOR-2464)'
---

### Added

- Apps in Connections now show their real logo and one plain line about what each one does. The popular apps ship their logos with DorkOS, so they show before anything is set up, and offline. Other apps use the logo their connection service sends. DorkOS fetches it once and keeps a copy, so your browser never loads another company's site. An app with no logo keeps its letter tile, and searching for what an app does now finds it (DOR-2464)
