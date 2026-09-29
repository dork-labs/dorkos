---
covers:
  - 'feat(extensions): let extensions add a page, a status-bar item and a tab dot (DOR-2525)'
  - "fix(extensions): keep an extension page's address exactly as written, and harden its title, icon and status items (DOR-2525 review)"
  - 'fix(extensions): wait out an extension reload before saying its page is missing (DOR-2525)'
---

### Added

- Extensions can now add a full page, an item in the chat status bar, and a dot on their tab in the right panel. Find an extension's pages in the command palette under "Add-ons", or on your phone under "Add-ons" in the You tab. Reloading on an extension's page brings you back to it (DOR-2525)

### Fixed

- When an extension asks DorkOS to take you somewhere in the app, it now goes there. Before, the request was quietly ignored (DOR-2525)
- A link whose address holds a value like `1.10` or `-0` no longer has it changed to `1.1` or `0` when DorkOS opens it (DOR-2525)
