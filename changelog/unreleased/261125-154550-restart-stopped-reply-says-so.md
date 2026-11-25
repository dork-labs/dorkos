---
covers:
  - 'feat(runs): every window reads a chat’s status from its run record (DOR-5212)'
---

### Fixed

- When DorkOS restarts in the middle of a reply, the chat now says so: "DorkOS restarted during this reply, so it stopped. Send a message to continue." Every open window shows it, and so does a window you open later. Before, the reply just stopped with nothing to say why. (DOR-5212)

### Added

- `GET /api/sessions/{id}/runs` lists a chat's runs for scripts and integrations: the one running now, the ones waiting behind it, and how the last one ended. It is the same list every window reads. (DOR-5212)
