---
covers:
  - 'fix(client): stop showing the literal `default` model sentinel (DOR-1279)'
  - 'fix(client): stop the cold-catalog default-sentinel leak in the status bar (DOR-1279 adversarial review)'
---

### Fixed

- A session running a runtime's own default model no longer shows a
  meaningless "· default" after the runtime name — including in the
  status bar during the moment right after startup, before the model
  list has finished loading (DOR-1279)
