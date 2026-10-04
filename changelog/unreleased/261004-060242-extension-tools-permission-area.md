---
covers:
  - 'feat(permissions): add the Extension tools permission area (DOR-2685)'
  - 'feat(capabilities): live extension layer on the capability registry (DOR-2685)'
  - 'feat(capabilities): name the extension behind a tool and announce catalog changes (DOR-2685)'
---

### Added

- Settings → Permissions has a new **Extension tools** area, for tools an installed extension gives your agents. Careful asks first; Balanced and Full power allow them. A tool that deletes or removes something still asks first, even when the area is Allowed. Each tool's row names the extension it came from. Extensions can't add tools yet, so the area is empty for now (DOR-2685)
