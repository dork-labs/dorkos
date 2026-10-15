---
id: 261014-100000
kind: fix
covers:
  - 'fix: initialize cold harness schemas and align Doc CI contracts'
---

### Fixed

- Initialize harness schema metadata before the first cold OpenAPI import.
- Assert pending Doc focus before the next event can close the batch.
- Supply a valid generation when testing unknown Doc and caller refusals.
- Require all 57 isolated checkbox assertions and document the report validator.
