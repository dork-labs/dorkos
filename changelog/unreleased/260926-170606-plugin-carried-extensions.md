---
covers:
  - 'feat(extensions): load extensions that come inside an installed plugin, once you approve that copy (DOR-2383)'
---

### Added

- Extensions that come inside a plugin now load, once you approve them. Before, an extension packed inside a marketplace plugin was set up on install but never showed up or ran. It now appears in Settings → Extensions and asks for your OK like any other extension (DOR-2383)

### Security

- Your OK to run an extension now belongs to that one copy of it: its folder, and the plugin it came in. If a different plugin brings an extension with the same name, DorkOS asks you again before running any of it. Extensions you already allowed keep running with nothing to click (DOR-2383)
