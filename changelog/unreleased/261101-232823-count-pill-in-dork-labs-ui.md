---
covers:
  - 'refactor(ui): CountPill lives in @dork-labs/ui so the app and the Space share one count (DOR-3635)'
  - 'refactor(ui): CountPill draws from @dork-labs/ui tokens so the Space can use it (DOR-3635)'
---

### Added

- `@dork-labs/ui` now ships `CountPill`, the numbered pill the DorkOS app uses for mentions and waiting items, at `@dork-labs/ui/count-pill`. It draws from the package's own tokens, so it looks the same in any app that loads `@dork-labs/ui/tailwind.css`, and the DorkOS app's counts look exactly as before (DOR-3635)
