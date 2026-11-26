---
covers:
  - 'feat(cloud-api): the front door of a cloud home, and what wakes one (DOR-5464)'
---

### Added

- `@dork-labs/cloud-api` now says what the front door of your DorkOS in the cloud owns and what your DorkOS owes it: a path prefix that never reaches your DorkOS (`FRONT_DOOR_RESERVED_PATH_PREFIX`, with the space's wake at `FRONT_DOOR_WAKE_PATH`), at least a minute awake after the last request (`HUB_AWAKE_AFTER_LAST_REQUEST_SECONDS`), the short list of paths a computer reaches without your sign-in (`FRONT_DOOR_UNSIGNED_PATHS`), the front door's two cookies your DorkOS never logs or passes on (`FRONT_DOOR_COOKIE_NAMES`), three refusals (`sign_in_required`, `hub_starting_failed`, `hub_unavailable`), and an optional `serving` in its health answer (`HubHealthSchema`). An older DorkOS still parses everything it parsed before, and an older app shows these refusals as an error (DOR-5464).

### Changed

- The contract's list of what wakes a sleeping DorkOS in the cloud is now complete and in one place: it adds a space's wake beside the published-page wake. A request for an agent there wakes it only from its signed-in owner; from any caller the front door cannot check it answers `503` with `Retry-After` and wakes nothing (DOR-5465).
- Each wake now has a cap on how often it may start your DorkOS, counted in starts, not requests: its next-wake time, and a space's wake for each of its tokens, at most once every five minutes (`HUB_NEXT_WAKE_MIN_INTERVAL_SECONDS`); you, a page read and a computer each at most once a minute and 30 times an hour (`HUB_WAKE_STARTS_PER_MINUTE`, `HUB_WAKE_STARTS_PER_HOUR`). Your DorkOS never goes to sleep within a minute of the last request it served (DOR-5465).
- A DorkOS in the cloud that stops with an error is started again up to three times in a row (`HUB_FAILED_EXIT_RESTARTS_MAX`); one that keeps failing stays stopped until the next wake. One that stops cleanly is asleep (DOR-5465).
