---
covers:
  - 'feat(extensions): say when an extension still serves with the old router (DOR-2858)'
  - 'feat(extensions): teach one way to serve an extension API, with Hono (DOR-2858)'
---

### Changed

- A new extension's server half is now a Hono app, with only people allowed to change its data. The starter template, the guide agents read and the docs all show this one way.

### Deprecated

- The old Express router for an extension's server half. It still works for now. An extension that uses it says "Uses an older server style DorkOS will drop soon" in **Settings > Extensions**, and an agent can update it in one request.
