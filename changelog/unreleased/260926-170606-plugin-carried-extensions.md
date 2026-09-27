---
covers:
  - 'feat(extensions): load extensions that come inside an installed plugin, once you approve that copy (DOR-2383)'
  - "fix(extensions): keep an extension's approval when its own plugin updates (DOR-2383)"
  - "fix(extensions): leave another plugin's running copy alone on uninstall, and forget dropped extensions on reinstall (DOR-2383)"
---

### Added

- Extensions that come inside a plugin now load, once you approve them. Before, an extension packed inside a marketplace plugin was set up on install but never showed up or ran. It now appears in Settings → Extensions and asks for your OK like any other extension (DOR-2383)

### Security

- Your OK to run an extension now belongs to that one copy of it: its folder, and the plugin it came in. If a different plugin brings an extension with the same name, DorkOS asks you again before running any of it. Extensions you already allowed keep running with nothing to click, and updating a plugin keeps your OK for the extensions it still brings (DOR-2383)
