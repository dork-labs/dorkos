---
covers:
  - 'fix(client): durable streams ride WebSockets so several windows stay responsive (DOR-927)'
  - 'fix(server): trust the address DorkOS is actually reached on for stream upgrades (DOR-927)'
  - 'docs(streams): record the WebSocket move and document both stream protocols (DOR-927)'
  - 'docs(api): regenerate the OpenAPI spec for the WebSocket stream endpoints (DOR-927)'
  - 'docs(api): regenerate the API reference pages for the stream endpoints (DOR-927)'
  - 'fix(server): compare the whole origin on a stream upgrade, not just its hostname (DOR-927)'
  - 'docs(changelog): fold the DOR-927 fragments into one user-facing entry'
---

### Fixed

- You can keep several DorkOS windows open at once. Opening a third window used to make
  the whole app stop responding — activity dots froze, replies looked stuck halfway,
  reloads never finished, and a fourth window would not open at all. Those were all one
  problem, and it is fixed (DOR-927)

### Changed

- If you reach DorkOS through a reverse proxy, check that it passes WebSocket
  connections through — live output now uses them. The setup pages have working
  config for nginx and Caddy (DOR-927)
