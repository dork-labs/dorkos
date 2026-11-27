---
covers:
  - 'feat(cloud-api): the account directory holds account things only, a computer can wake its cloud home, and a cloud home says if it is home (DOR-5346)'
---

### Changed

- `@dork-labs/cloud-api` now says the account directory holds account things only: your homes and devices, whether each is reachable, whether each computer offers its own page, and the spaces you joined. The app sends no agents in its report (`agents: []`), a `reach` of `chat` or `full-control` only (the new `DirectoryReportReachSchema`), and no time zone or quiet hours. Every shape still parses what it parsed before. Nothing in the app calls the directory yet, so nothing you see changes (DOR-5346).

### Added

- `@dork-labs/cloud-api` gains `POST /v1/instances/hub-wake`: one of your own computers can ask the hosted service to wake your DorkOS in the cloud so it can deliver a notice, at most once a minute and 30 times an hour (`HUB_WAKE_REQUEST_MIN_INTERVAL_SECONDS`, `HUB_WAKE_REQUEST_MAX_PER_HOUR`). The contract now also lists everything that wakes it (DOR-5346).
- Your DorkOS in the cloud can now be told whether it is the home of your private space or your way in (`privateSpaceHome` in its assignment). It is decided once. When an older hosted service leaves it out, the hub records nothing and works as before (DOR-5346).
