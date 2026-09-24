---
covers:
  - 'feat(cli): remove what an uncertain Community launch create left behind, only with proof (DOR-2238)'
---

### Added

- `dorkos community deploy --remove-uncertain <run-id>` checks the one resource a stopped launch may have left behind when it could not tell whether a create worked. It removes the resource only when DorkOS can prove your launch made it and you type the id it shows, and it checks everything again just before deleting. Otherwise it removes nothing and tells you why, with the commands to check it yourself. After a removal, `--resume` continues the same launch. For now, DorkOS reports what it finds but removes nothing, because it has not yet confirmed this proof against a real Fly and Neon launch (DOR-2238).
