---
covers:
  - 'feat(api): the OpenAPI document names every operation, declares how to sign in and tracks the product version (DOR-4980)'
  - 'fix(api): operation ids come from paths alone, and each operation says what sign-in it takes (DOR-4980)'
  - 'fix(api): a GET that pages by limit or cursor is named list (DOR-4980)'
  - 'fix(api): the hub link path is checked against a real hub gate, and pinning an id is documented (DOR-4980)'
  - 'fix(api): the hub link description passes the vocabulary gate (DOR-4980)'
  - 'fix(api): the connectors group mounts by its literal path, so the mount census still reads it (DOR-4980)'
---

### Added

- The API document now names every operation and says how to sign in. Tools that build a client from it get a stable name for each call, and its version now matches the DorkOS version you run.
