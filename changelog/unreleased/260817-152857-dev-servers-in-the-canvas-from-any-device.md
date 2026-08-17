---
covers:
  - 'feat(server,client): dev-server previews get their own origin — see them from any device, live reload included (P2, DOR-1260)'
---

### Added

- See a dev server you're running in the canvas from your phone, your tablet, or another laptop — not just the machine it runs on. Live reload keeps working, and pages with deep links open where you asked for them. When a preview can't be shown, the canvas says why in a sentence you can act on instead of going blank.

### Fixed

- Agents can read the console and failed requests of a preview again while you're running DorkOS in development mode. The code that watches the page had been failing to start, silently.
