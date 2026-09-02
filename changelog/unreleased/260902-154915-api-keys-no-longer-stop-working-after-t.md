---
covers:
  - 'fix(server,db): API keys are not throttled to ten uses a day (DOR-489)'
  - 'fix(server,db): address review nits on the API-key rate-limit fix (DOR-489)'
---

### Fixed

- Fixed a bug where an API key stopped working after ten uses in a day. With **Require login** turned on, the `dorkos` command sends your key on every request, so the eleventh command of the day came back "unauthorized" — as if the key had been revoked. Keys are no longer capped this way, and keys you already created start working again with no action from you (DOR-489)
