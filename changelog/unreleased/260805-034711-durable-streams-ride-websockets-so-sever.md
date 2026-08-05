---
covers:
  - 'fix(client): durable streams ride WebSockets so several windows stay responsive (DOR-927)'
  - 'fix(server): trust the address DorkOS is actually reached on for stream upgrades (DOR-927)'
  - 'docs(streams): record the WebSocket move and document both stream protocols (DOR-927)'
  - 'docs(api): regenerate the OpenAPI spec for the WebSocket stream endpoints (DOR-927)'
  - 'docs(api): regenerate the API reference pages for the stream endpoints (DOR-927)'
  - 'fix(server): compare the whole origin on a stream upgrade, not just its hostname (DOR-927)'
  - 'docs(changelog): fold the DOR-927 fragments into one user-facing entry'
  - 'test(e2e): tap the room and global streams as WebSockets, not fetch (DOR-927)'
  - 'refactor(client): drop the now-dead EventSource mock and a stale timeout rationale (DOR-927)'
  - 'fix(server): the upgrade origin check no longer stands down inside the container (DOR-927)'
  - 'fix(server): drop DORKOS_PUBLIC_URL as a trust branch and refuse opaque origins (DOR-927)'
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
- Running the Docker image and reaching it by a name rather than an IP (`http://dorkos.lan:4242`)?
  Add `DORKOS_TRUSTED_HOSTS=dorkos.lan`. Without it the page loads and the live updates never
  arrive — the Docker page explains why (DOR-927)
