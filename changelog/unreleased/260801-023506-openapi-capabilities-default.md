---
covers:
  - 'fix(server): the API reference documents the default permission mode it serves'
---

### Fixed

- The API reference now documents the `permissionModes.default` field that `/api/capabilities` has always returned, so anyone building against the API can see which mode a runtime falls back to.
