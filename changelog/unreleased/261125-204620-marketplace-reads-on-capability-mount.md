---
covers:
  - 'fix(api): the marketplace reads on /api/marketplace are served by the capability mount, the dev links person-only (DOR-4978)'
---

### Changed

- For scripts that use the DorkOS API: the marketplace's lists (sources, cache, packages, installed packages, updates, held-back packages and dev links) have new operation names, such as `marketplace.list_sources` and `marketplace.check_updates`. Their paths and answers are the same.
- The list of dev links is now only for a person. A call from an agent, or one that sends an API key or any `Authorization` header, is refused with `person_only`.
- Read by an agent, through the API or its `marketplace_list_installed` tool, the installed packages and the held-back packages leave out the folder a linked package runs from.
- When an update check fails because a package is broken or clashes with another, the answer keeps its code but no longer lists the details in `errors` or `conflicts`, and its sentence no longer points at them.
- On a server where the marketplace didn't start, these lists answer `404` with `unknown_capability`.
