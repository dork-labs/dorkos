---
covers:
  - 'fix(server): an extension can only write its own data, secrets and settings (DOR-3066)'
---

### Fixed

- An extension can no longer change another extension's saved data, secrets or settings through DorkOS: each write is checked against the extension that made it. With **Require login** on, these writes also need you signed in, or an agent that says who it is, so a program on your computer can't change them with only a key.
