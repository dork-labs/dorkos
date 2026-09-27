---
covers:
  - 'feat(server): show a hard usage limit on the session and notify once per limit (DOR-2382)'
  - 'fix(server): renumber session_limits to 0117 and leave limits out of the account rename (DOR-2382)'
  - 'fix(server): never show a raw account id in a usage-limit notification (DOR-2382)'
---

### Fixed

- When a Claude account runs out of usage, the session no longer stops without a word. It now shows Claude's own message, such as "You've hit your weekly limit", and it remembers that the account is out until the limit resets, even after DorkOS restarts. The limit clears when you send the session its next message (DOR-2382)

### Added

- You get one notification when a Claude account runs out of usage, however many sessions were using that account. It says when the account comes back, if Claude said (DOR-2382)
