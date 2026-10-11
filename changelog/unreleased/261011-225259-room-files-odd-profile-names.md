---
covers:
  - 'fix(server): room enable and repair commits use the safe git author name (DOR-2454)'
---

### Fixed

- Turning on a room's files, or keeping changes made outside DorkOS, no longer fails when your profile name is made only of symbols git cannot use, such as `<>`. DorkOS signs those saves with a plain name instead (DOR-2454)
