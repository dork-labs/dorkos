---
covers:
  - 'fix(server): a catalog that admits it is a guess cannot refuse a model (DOR-1688)'
---

### Fixed

- Picking an OpenCode model no longer fails with "the opencode runtime cannot run model ..." when the model list is a bounded guess. With no OpenCode provider connected, DorkOS shows a shortened, unconfirmed menu — and if your credentials come from environment variables, a model you can really run may sit outside it. That menu now stops being used to turn your choice down. A confirmed list still turns down a model it genuinely does not have (DOR-1688)
