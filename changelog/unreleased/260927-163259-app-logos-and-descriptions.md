---
covers:
  - 'feat(connections): show each app’s real logo and one line about it (DOR-2464)'
  - 'feat(connections): find an app by its one line when searching (DOR-2464)'
---

### Added

- Every app in Connections now shows its real logo and one plain line about what it is. The popular apps ship their logos with DorkOS, so they show before anything is set up, and offline. Other apps use the logo their connection service sends. DorkOS fetches it once and keeps a copy, so your browser never loads another company's site. An app with no logo keeps its letter tile, and searching for what an app does now finds it (DOR-2464)
