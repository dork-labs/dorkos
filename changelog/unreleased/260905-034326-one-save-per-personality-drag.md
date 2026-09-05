---
covers:
  - 'fix(client,scripts): one save per personality drag, and an .env.example that cannot drift (DOR-1646)'
---

### Fixed

- Changing an agent's personality saves once, when you let go of the slider. Dragging one dial used to send a save on every step it crossed, and the handle lagged behind your finger while it caught up (DOR-1646)

### Changed

- `.env.example` now lists every setting the server reads — the telemetry off switches, rate limits, tracing, and the self-hosted connector gateway among them — and no longer describes a scheduler switch that nothing reads any more (DOR-1646)
