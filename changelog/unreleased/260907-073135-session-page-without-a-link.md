---
covers:
  - 'fix(client): opening the session page without a link no longer flashes errors (DOR-1836)'
---

### Fixed

- Opening the session page without a link no longer flashes errors on its way in. DorkOS picks the conversation you were last having and sends you there, but it was not saying which project that conversation belongs to — so the page asked for a transcript it could not place, got two errors back, and settled on an empty screen before recovering. It now names the project, and the conversation opens straight away (DOR-1836)
