---
covers:
  - 'fix(cli): `dorkos telemetry enable errors` without `--channel` no longer turns every channel on (DOR-4414)'
---

### Fixed

- Typing `dorkos telemetry enable errors` without `--channel` used to turn on every kind of data DorkOS can send. Now it changes nothing and asks "Did you mean `--channel errors`?". `--channel errors` still turns on crash reports alone.
