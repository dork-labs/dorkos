---
covers:
  - 'fix(server): send /v1 Cloud calls to the Cloud service, not the website (DOR-2673)'
---

### Fixed

- On a fresh install, requests for DorkOS credits, your balance and your plan now go to the DorkOS Cloud service. They went to the dorkos.ai website, which can't answer them, so every one failed (DOR-2673)

### Added

- A `DORKOS_CLOUD_API_URL` setting, to send only those requests somewhere else
