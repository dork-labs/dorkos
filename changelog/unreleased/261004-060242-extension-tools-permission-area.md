---
covers:
  - 'feat(permissions): add the Extension tools permission area (DOR-2685)'
  - 'feat(capabilities): live extension layer on the capability registry (DOR-2685)'
  - 'feat(capabilities): name the extension behind a tool and announce catalog changes (DOR-2685)'
  - 'fix(capabilities): harden what an extension may contribute (DOR-2685)'
  - 'fix(capabilities): refuse look-alike and invisible text in extension names (DOR-2685)'
---

### Added

- Settings → Permissions has a new **Extension tools** area, for tools an installed extension gives your agents. Careful asks first; Balanced and Full power allow them. A tool that deletes or removes something asks every time, even if you set it to Allowed. Each tool's row names the extension it came from (DOR-2685)
