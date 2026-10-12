---
covers:
  - 'fix(server): send /v1 Cloud calls to the Cloud service, not the website (DOR-2673)'
---

### Fixed

- DorkOS credits, your balance and your plan now work on a fresh install. The app was asking the dorkos.ai website for them, which can't answer, so every request failed (DOR-2673)
- To point only those requests somewhere else, set `DORKOS_CLOUD_API_URL`
