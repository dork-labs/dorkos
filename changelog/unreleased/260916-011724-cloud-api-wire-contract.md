---
covers:
  - 'feat(cloud-api): the public wire contract for DorkOS Cloud (DOR-2025)'
---

### Added

- Publish `@dork-labs/cloud-api`, the public wire contract for DorkOS Cloud: Zod schemas for the whole `/v1` surface, a thin `fetch` client, and a corpus of example payloads both sides of the wire can build against. It has no dependency on anything else in this repository, so anyone can read exactly what the app and the hosted service say to each other (DOR-2025)
