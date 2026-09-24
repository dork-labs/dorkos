---
covers:
  - 'feat(cli): mark each Community launch create so its resources can be traced back (DOR-2238)'
---

### Changed

- `dorkos community deploy` now marks what it creates so a later check can tell your launch's resources apart from anyone else's. Before each step, it saves a random code in the recovery journal. The Fly app gets its own private network named after that code, and the Neon database role is named `community_` plus a code instead of `community_owner`. Because of the separate network, the app can't reach your other Fly apps over Fly's private network. Community doesn't need to. Launches you already started keep working as before (DOR-2238).
